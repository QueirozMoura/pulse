import type { FastifyInstance } from "fastify";
import type { Db } from "../lib/db.js";

export type SchedulerStatus = "ok" | "stalled" | "disabled";

/**
 * Saúde do próprio Pulse. Público, então só diz "ok/degraded" e o estado do scheduler:
 * nada de versão, uptime, nomes de host ou mensagens de erro.
 * 503 se o banco estiver inacessível ou o scheduler travado (a hospedagem pode reiniciar o serviço).
 */
export function healthRoutes(app: FastifyInstance, db: Db, schedulerStatus: () => SchedulerStatus): void {
  app.get("/health", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    const scheduler = schedulerStatus();
    try {
      await db.$queryRaw`SELECT 1`;
    } catch (err) {
      app.log.error({ err }, "health check: database unreachable");
      return reply.code(503).send({ status: "degraded", scheduler });
    }
    if (scheduler === "stalled") return reply.code(503).send({ status: "degraded", scheduler });
    return { status: "ok", scheduler };
  });
}
