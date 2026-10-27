import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { createGuards } from "./auth/guards.js";
import type { Config } from "./config.js";
import type { Db } from "./lib/db.js";
import { AppError } from "./lib/errors.js";
import { loginRoute, sessionRoutes } from "./routes/auth.js";
import { healthRoutes, type SchedulerStatus } from "./routes/health.js";
import { monitorRoutes } from "./routes/monitors.js";
import { publicRoutes } from "./routes/public.js";

export interface RouteInfo {
  method: string;
  url: string;
  /** true se a rota está no escopo protegido (sessão + CSRF). */
  protected: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Todas as rotas registradas; usado nos testes para provar que nada novo ficou sem proteção. */
    routeTable: RouteInfo[];
  }
}

export interface AppDeps {
  /** Estado do scheduler para o /health. Padrão: desabilitado. */
  schedulerStatus?: () => SchedulerStatus;
}

export function buildApp(config: Config, db: Db, deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers[set-cookie]"],
    },
    bodyLimit: 16 * 1024,
    forceCloseConnections: "idle", // shutdown não fica preso em conexões keep-alive ociosas
    // Só confia nos N proxies mais próximos; X-Forwarded-For forjado pelo cliente fica fora.
    trustProxy: config.TRUST_PROXY_HOPS > 0 ? (_addr: string, hop: number) => hop < config.TRUST_PROXY_HOPS : false,
  });

  // Os hooks onRoute da raiz disparam antes dos do escopo filho, então "protegida" é resolvida sob demanda.
  const allRoutes: Omit<RouteInfo, "protected">[] = [];
  const protectedKeys = new Set<string>();
  const key = (method: string, url: string) => `${method} ${url}`;
  app.decorate("routeTable", {
    getter: (): RouteInfo[] => allRoutes.map((r) => ({ ...r, protected: protectedKeys.has(key(r.method, r.url)) })),
  });
  app.decorateRequest("session", null);
  app.addHook("onRoute", (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const method of methods) {
      if (method !== "HEAD" && method !== "OPTIONS") allRoutes.push({ method, url: r.url });
    }
  });

  // Só JSON. Remove o parser padrão de text/plain, que um formulário cross-site consegue enviar sem preflight.
  app.removeAllContentTypeParsers();
  // JSON vazio (ex.: POST /monitors/:id/pause sem corpo) é aceito como "sem corpo".
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "") return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error("invalid json"), { statusCode: 400 }), undefined);
    }
  });

  app.register(cookie);
  if (config.CORS_ALLOWED_ORIGIN) {
    app.register(cors, {
      origin: new URL(config.CORS_ALLOWED_ORIGIN).origin,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE"],
      allowedHeaders: ["content-type", "x-csrf-token"],
    });
  }

  // Todo corpo de erro tem o mesmo formato: { error, message, requestId, issues? }.
  // `error` é um código estável para o cliente; `message` é texto seguro; detalhes internos só vão para o log.
  const STATUS_CODES: Record<number, string> = {
    400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found",
    405: "method_not_allowed", 413: "payload_too_large", 415: "unsupported_media_type", 429: "too_many_requests",
  };
  const body = (req: { id: string }, error: string, message: string, extra: object = {}) => ({
    error, message, requestId: req.id, ...extra,
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("x-content-type-options", "nosniff");
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).headers(err.headers).send(body(req, err.code, err.message));
    }
    if (err instanceof ZodError) {
      return reply.code(400).send(
        body(req, "validation_error", "Dados inválidos", {
          issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        }),
      );
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send(body(req, STATUS_CODES[status] ?? "bad_request", "Requisição inválida"));
    }
    req.log.error({ err }, "unhandled error"); // detalhes só no log
    return reply.code(500).send(body(req, "internal_error", "Erro interno"));
  });

  app.setNotFoundHandler((req, reply) => reply.code(404).send(body(req, "not_found", "Rota não encontrada")));

  // --- Rotas públicas (sem sessão) ---
  healthRoutes(app, db, deps.schedulerStatus ?? (() => "disabled"));
  publicRoutes(app, db);
  app.register(async (scope) => {
    scope.addHook("onSend", async (_req, reply) => void reply.header("cache-control", "no-store"));
    loginRoute(scope, db, config); // única rota de auth sem sessão
  });

  // --- Escopo protegido: TODA rota administrativa nasce aqui, atrás de sessão + CSRF ---
  // Não há flag nem registro alternativo: se a rota está neste escopo, os hooks se aplicam.
  const guards = createGuards(db, config);
  app.register(async (priv) => {
    priv.addHook("onRoute", (r) => {
      for (const method of Array.isArray(r.method) ? r.method : [r.method]) protectedKeys.add(key(method, r.url));
    });
    priv.addHook("onRequest", guards.authenticate);
    priv.addHook("onRequest", guards.csrf);
    priv.addHook("onSend", async (_req, reply) => void reply.header("cache-control", "no-store"));
    sessionRoutes(priv, db, config);
    monitorRoutes(priv, db, {
      minIntervalSeconds: config.MIN_INTERVAL_SECONDS,
      checkTimeoutMs: config.CHECK_TIMEOUT_MS,
      maxMonitors: config.MAX_MONITORS,
    });
  });

  return app;
}
