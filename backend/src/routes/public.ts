import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../lib/db.js";

const HISTORY_DEFAULT = 50;
const HISTORY_MAX = 200;

/**
 * Leitura pública. Não expõe URL, mensagens de erro nem nada interno:
 * apenas nome, estado, métricas e categoria sanitizada de falha.
 */
export function publicRoutes(app: FastifyInstance, db: Db): void {
  app.get("/public/status", async () => {
    const monitors = await db.monitor.findMany({
      where: { active: true },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        status: true,
        lastCheckedAt: true,
        checks: { orderBy: { checkedAt: "desc" }, take: 1, select: { latencyMs: true } },
        incidents: { where: { resolvedAt: null }, take: 1, select: { startedAt: true } },
      },
    });

    return {
      monitors: monitors.map((m) => ({
        id: m.id,
        name: m.name,
        status: m.status,
        lastCheckedAt: m.lastCheckedAt,
        lastLatencyMs: m.checks[0]?.latencyMs ?? null,
        ongoingIncident: m.incidents[0] ? { startedAt: m.incidents[0].startedAt } : null,
      })),
    };
  });

  const paramsSchema = z.object({ id: z.uuid() });
  const querySchema = z.object({
    limit: z.coerce.number().int().min(1).max(HISTORY_MAX).default(HISTORY_DEFAULT),
  });

  app.get("/public/monitors/:id/history", async (req, reply) => {
    const { id } = paramsSchema.parse(req.params);
    const { limit } = querySchema.parse(req.query);

    const monitor = await db.monitor.findFirst({
      where: { id, active: true },
      select: { id: true, name: true, status: true },
    });
    if (!monitor) return reply.code(404).send({ error: "not_found", message: "Monitor não encontrado" });

    const [checks, incidents] = await Promise.all([
      db.checkResult.findMany({
        where: { monitorId: id },
        orderBy: { checkedAt: "desc" },
        take: limit,
        select: { checkedAt: true, success: true, statusCode: true, latencyMs: true, errorKind: true },
      }),
      db.incident.findMany({
        where: { monitorId: id },
        orderBy: { startedAt: "desc" },
        take: 20,
        select: { startedAt: true, resolvedAt: true },
      }),
    ]);

    return { monitor, checks, incidents };
  });
}
