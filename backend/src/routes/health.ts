import type { FastifyInstance } from "fastify";
import type { Db } from "../lib/db.js";
import { workerHealth } from "../worker/health.js";

export type SchedulerStatus = "ok" | "stalled" | "disabled";

export interface HealthDeps {
  schedulerStatus: () => SchedulerStatus;
  /** Definido quando as checagens vêm de um worker externo (GitHub Actions): informa o batimento dele. */
  worker?: { expectedEveryMinutes: number; lateAfterMinutes: number };
}

/**
 * - `GET /health/live`: o processo está de pé. NÃO consulta o banco (nem o acorda). É o caminho para o health check da
 *   hospedagem: no plano gratuito do Neon, cada consulta acorda a computação e consome horas do limite mensal.
 * - `GET /health`: API + banco (+ scheduler interno, se houver) e, separadamente, o batimento do worker.
 *   503 só se o banco estiver inacessível ou o scheduler INTERNO travado. O worker atrasado aparece em `worker.status`
 *   ("late") mas NUNCA muda o código HTTP: um agendamento atrasado do GitHub não pode fazer a hospedagem reiniciar a API.
 * Público: nada de versão, uptime ou mensagens de erro.
 */
export function healthRoutes(app: FastifyInstance, db: Db, deps: HealthDeps): void {
  app.get("/health/live", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    return { status: "ok" };
  });

  app.get("/health", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    const scheduler = deps.schedulerStatus();
    try {
      await db.$queryRaw`SELECT 1`;
    } catch (err) {
      app.log.error({ err }, "health check: database unreachable");
      return reply.code(503).send({ status: "degraded", scheduler });
    }
    const worker = deps.worker ? await workerHealth(db, deps.worker) : undefined;
    if (scheduler === "stalled") return reply.code(503).send({ status: "degraded", scheduler, ...(worker && { worker }) });
    return { status: "ok", scheduler, ...(worker && { worker }) };
  });
}
