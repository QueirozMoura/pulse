import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../lib/db.js";
import { monitorUrlSchema } from "../domain/monitor-url.js";

const MAX_INTERVAL_SECONDS = 86_400;

/** Gerenciamento de monitores. Sem autenticação nesta etapa; inclui a URL, por isso NÃO é público. */
export function monitorRoutes(app: FastifyInstance, db: Db, minIntervalSeconds: number): void {
  const createSchema = z.object({
    name: z.string().trim().min(1).max(100),
    url: monitorUrlSchema,
    intervalSeconds: z.number().int().min(minIntervalSeconds).max(MAX_INTERVAL_SECONDS),
  });

  app.post("/monitors", async (req, reply) => {
    const body = createSchema.parse(req.body);
    const monitor = await db.monitor.create({
      data: { name: body.name, url: body.url, intervalSeconds: body.intervalSeconds, nextCheckAt: new Date() },
    });
    return reply.code(201).send(toDto(monitor));
  });

  app.get("/monitors", async () => {
    const monitors = await db.monitor.findMany({ orderBy: { createdAt: "asc" } });
    return { monitors: monitors.map(toDto) };
  });
}

function toDto(m: {
  id: string; name: string; url: string; intervalSeconds: number;
  active: boolean; status: string; lastCheckedAt: Date | null; createdAt: Date;
}) {
  return {
    id: m.id,
    name: m.name,
    url: m.url,
    intervalSeconds: m.intervalSeconds,
    active: m.active,
    status: m.status,
    lastCheckedAt: m.lastCheckedAt,
    createdAt: m.createdAt,
  };
}
