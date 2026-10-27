import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../lib/db.js";
import { AppError, notFound } from "../lib/errors.js";
import { monitorUrlSchema } from "../domain/monitor-url.js";

const MAX_INTERVAL_SECONDS = 86_400;

/**
 * Administração de monitores. Só é registrada dentro do escopo protegido
 * (autenticação + CSRF); inclui a URL monitorada, por isso nunca é pública.
 */
export function monitorRoutes(
  app: FastifyInstance,
  db: Db,
  limits: { minIntervalSeconds: number; checkTimeoutMs: number; maxMonitors: number },
): void {
  // O intervalo precisa ser maior que o timeout: assim a checagem anterior sempre termina antes da próxima.
  const minIntervalSeconds = Math.max(limits.minIntervalSeconds, Math.floor(limits.checkTimeoutMs / 1000) + 1); // = effectiveMinIntervalSeconds
  const name = z.string().trim().min(1).max(100);
  const intervalSeconds = z.number().int().min(minIntervalSeconds).max(MAX_INTERVAL_SECONDS);

  const createSchema = z.object({ name, url: monitorUrlSchema, intervalSeconds }).strict();
  const updateSchema = z
    .object({ name: name.optional(), url: monitorUrlSchema.optional(), intervalSeconds: intervalSeconds.optional() })
    .strict()
    .refine((v) => Object.keys(v).length > 0, "Informe ao menos um campo");
  const params = z.object({ id: z.uuid() });

  const find = async (id: string) => {
    const m = await db.monitor.findUnique({ where: { id } });
    if (!m) throw notFound("Monitor não encontrado");
    return m;
  };

  app.post("/monitors", async (req, reply) => {
    const body = createSchema.parse(req.body);
    if ((await db.monitor.count()) >= limits.maxMonitors) {
      throw new AppError(409, "monitor_limit_reached", `Limite de ${limits.maxMonitors} monitores atingido`);
    }
    const monitor = await db.monitor.create({ data: { ...body, nextCheckAt: new Date() } });
    return reply.code(201).send(toDto(monitor));
  });

  app.get("/monitors", async () => {
    const monitors = await db.monitor.findMany({ orderBy: { createdAt: "asc" } });
    return { monitors: monitors.map(toDto) };
  });

  app.get("/monitors/:id", async (req) => toDto(await find(params.parse(req.params).id)));

  app.patch("/monitors/:id", async (req) => {
    const { id } = params.parse(req.params);
    const body = updateSchema.parse(req.body);
    const current = await find(id);

    const data: Record<string, unknown> = { ...body };
    const now = new Date();
    if (body.url !== undefined && body.url !== current.url) {
      data.nextCheckAt = now; // novo alvo: checa já
    } else if (body.intervalSeconds !== undefined) {
      // intervalo menor não pode esperar o agendamento antigo
      const soonest = new Date(now.getTime() + body.intervalSeconds * 1000);
      if (soonest < current.nextCheckAt) data.nextCheckAt = soonest;
    }
    return toDto(await db.monitor.update({ where: { id }, data }));
  });

  app.post("/monitors/:id/pause", async (req) => {
    const { id } = params.parse(req.params);
    await find(id);
    return toDto(await db.monitor.update({ where: { id }, data: { active: false } }));
  });

  app.post("/monitors/:id/resume", async (req) => {
    const { id } = params.parse(req.params);
    await find(id);
    return toDto(await db.monitor.update({ where: { id }, data: { active: true, nextCheckAt: new Date() } }));
  });

  app.delete("/monitors/:id", async (req, reply) => {
    const { id } = params.parse(req.params);
    await find(id);
    await db.monitor.delete({ where: { id } }); // checagens e incidentes saem em cascata
    return reply.code(204).send();
  });
}

function toDto(m: {
  id: string; name: string; url: string; intervalSeconds: number; active: boolean; status: string;
  consecutiveFailures: number; nextCheckAt: Date; lastCheckedAt: Date | null; createdAt: Date;
}) {
  return {
    id: m.id,
    name: m.name,
    url: m.url,
    intervalSeconds: m.intervalSeconds,
    active: m.active,
    status: m.status,
    consecutiveFailures: m.consecutiveFailures,
    nextCheckAt: m.nextCheckAt,
    lastCheckedAt: m.lastCheckedAt,
    createdAt: m.createdAt,
  };
}
