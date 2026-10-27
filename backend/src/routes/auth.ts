import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDummyHash, verifyPassword } from "../auth/password.js";
import { assertAllowedOrigin, cookieOptions, sessionCookieName } from "../auth/guards.js";
import { createSession, destroySession, purgeExpiredSessions } from "../auth/session.js";
import { checkLoginThrottle, clearLoginFailures, recordLoginFailure } from "../auth/throttle.js";
import { effectiveMinIntervalSeconds, type Config } from "../config.js";
import type { Db } from "../lib/db.js";
import { AppError } from "../lib/errors.js";

/** Limites que o painel precisa conhecer (ex.: menor intervalo aceito), para não duplicá-los no frontend. */
const limitsOf = (config: Config) => ({
  minIntervalSeconds: effectiveMinIntervalSeconds(config),
  maxMonitors: config.MAX_MONITORS,
});

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(128),
});

/** Login: única rota de autenticação que não exige sessão. */
export function loginRoute(app: FastifyInstance, db: Db, config: Config): void {
  app.post("/auth/login", async (req, reply) => {
    assertAllowedOrigin(req, config); // evita "login CSRF"
    const body = loginSchema.parse(req.body);

    // O limite vem ANTES do scrypt: tentativas bloqueadas não consomem CPU.
    const decision = await checkLoginThrottle(db, req.ip, {
      windowMinutes: config.LOGIN_WINDOW_MINUTES,
      maxPerIp: config.LOGIN_MAX_FAILURES_PER_IP,
      maxGlobal: config.LOGIN_MAX_FAILURES_GLOBAL,
    });
    if (!decision.allowed) {
      req.log.warn({ ip: req.ip }, "login blocked by throttle");
      throw new AppError(429, "too_many_attempts", "Muitas tentativas. Tente novamente mais tarde.", {
        "retry-after": String(decision.retryAfterSeconds),
      });
    }

    const admin = await db.adminUser.findUnique({ where: { username: body.username.toLowerCase() } });
    // Usuário inexistente também executa um scrypt: o tempo de resposta não revela se o usuário existe.
    const passwordOk = await verifyPassword(body.password, admin?.passwordHash ?? (await getDummyHash()));
    if (!admin || !passwordOk) {
      await recordLoginFailure(db, req.ip);
      req.log.warn({ ip: req.ip }, "login failed");
      throw new AppError(401, "invalid_credentials", "Credenciais inválidas");
    }

    await clearLoginFailures(db, req.ip);
    void purgeExpiredSessions(db).catch(() => undefined);
    const session = await createSession(db, admin.id, config.SESSION_TTL_HOURS);
    reply.setCookie(sessionCookieName(config), session.token, cookieOptions(config, session.expiresAt));
    req.log.info({ ip: req.ip }, "login succeeded");
    return { username: admin.username, csrfToken: session.csrfToken, expiresAt: session.expiresAt, limits: limitsOf(config) };
  });
}

/** Rotas que exigem sessão (registradas no escopo protegido). */
export function sessionRoutes(app: FastifyInstance, db: Db, config: Config): void {
  app.get("/auth/session", async (req) => {
    const s = req.session!;
    return { username: s.username, csrfToken: s.csrfToken, expiresAt: s.expiresAt, limits: limitsOf(config) };
  });

  app.post("/auth/logout", async (req, reply) => {
    await destroySession(db, req.session!.id);
    reply.clearCookie(sessionCookieName(config), { ...cookieOptions(config, new Date(0)), expires: undefined });
    return reply.code(204).send();
  });
}
