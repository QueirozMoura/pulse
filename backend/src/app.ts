import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./lib/db.js";
import { healthRoutes } from "./routes/health.js";
import { monitorRoutes } from "./routes/monitors.js";
import { publicRoutes } from "./routes/public.js";

export function buildApp(config: Config, db: Db): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 16 * 1024,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "validation_error",
        message: "Dados inválidos",
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: "bad_request", message: "Requisição inválida" });
    }
    // Detalhes só no log; o cliente recebe uma resposta genérica.
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "internal_error", message: "Erro interno" });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: "not_found", message: "Rota não encontrada" }),
  );

  healthRoutes(app, db);
  // Rotas de escrita NÃO são registradas quando desabilitadas: respondem 404, como se não existissem.
  if (config.ADMIN_ROUTES_ENABLED) {
    app.log.warn("ADMIN_ROUTES_ENABLED: rotas de gerenciamento SEM autenticação estão ativas");
    monitorRoutes(app, db, config.MIN_INTERVAL_SECONDS);
  }
  publicRoutes(app, db);
  return app;
}
