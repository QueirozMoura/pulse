import type { FastifyInstance } from "fastify";
import type { Db } from "../lib/db.js";

export function healthRoutes(app: FastifyInstance, db: Db): void {
  app.get("/health", async (_req, reply) => {
    try {
      await db.$queryRaw`SELECT 1`;
      return { status: "ok", uptimeSeconds: Math.round(process.uptime()) };
    } catch (err) {
      app.log.error({ err }, "health check: database unreachable");
      return reply.code(503).send({ status: "degraded" });
    }
  });
}
