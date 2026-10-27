import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { publicState, uptimeWindow, type PublicState, type UptimeWindow } from "../domain/public-state.js";
import { cursorSchema, encodeCursor, paginate } from "../lib/cursor.js";
import type { Db } from "../lib/db.js";
import { notFound } from "../lib/errors.js";

const HISTORY_DEFAULT = 50;
const HISTORY_MAX = 200;
const INCIDENTS_DEFAULT = 20;
const INCIDENTS_MAX = 100;
const PUBLIC_CACHE = "public, max-age=10";

interface PublicMonitor {
  id: string;
  name: string;
  state: PublicState;
  monitoringSince: Date;
  lastCheck: { checkedAt: Date; success: boolean; statusCode: number | null; latencyMs: number; errorKind: string | null } | null;
  ongoingIncident: { id: string; startedAt: Date } | null;
  uptime: { last24h: UptimeWindow; last7d: UptimeWindow };
}

/**
 * Leitura pública. Nunca expõe URL, mensagens de erro brutas, contagem interna de falhas nem
 * agendamento: só nome, estado, métricas e a categoria sanitizada de falha (errorKind).
 */
export function publicRoutes(app: FastifyInstance, db: Db): void {
  async function loadMonitors(onlyId?: string): Promise<PublicMonitor[]> {
    const monitors = await db.monitor.findMany({
      where: onlyId ? { id: onlyId } : undefined,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        active: true,
        status: true,
        lastCheckedAt: true,
        createdAt: true,
        checks: {
          orderBy: [{ checkedAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { checkedAt: true, success: true, statusCode: true, latencyMs: true, errorKind: true },
        },
        incidents: { where: { resolvedAt: null }, orderBy: { startedAt: "desc" }, take: 1, select: { id: true, startedAt: true } },
      },
    });
    const ids = monitors.map((m) => m.id);
    const [day, week] = await Promise.all([uptimeByMonitor(ids, 24), uptimeByMonitor(ids, 24 * 7)]);

    return monitors.map((m) => ({
      id: m.id,
      name: m.name,
      state: publicState(m),
      monitoringSince: m.createdAt,
      lastCheck: m.checks[0] ?? null,
      ongoingIncident: m.incidents[0] ?? null,
      uptime: { last24h: day.get(m.id) ?? uptimeWindow(0, 0), last7d: week.get(m.id) ?? uptimeWindow(0, 0) },
    }));
  }

  async function uptimeByMonitor(ids: string[], hours: number): Promise<Map<string, UptimeWindow>> {
    const out = new Map<string, UptimeWindow>();
    if (ids.length === 0) return out;
    const rows = await db.checkResult.groupBy({
      by: ["monitorId", "success"],
      where: { monitorId: { in: ids }, checkedAt: { gte: new Date(Date.now() - hours * 3_600_000) } },
      _count: { _all: true },
    });
    const tally = new Map<string, { total: number; ok: number }>();
    for (const r of rows) {
      const t = tally.get(r.monitorId) ?? { total: 0, ok: 0 };
      t.total += r._count._all;
      if (r.success) t.ok += r._count._all;
      tally.set(r.monitorId, t);
    }
    for (const [id, t] of tally) out.set(id, uptimeWindow(t.total, t.ok));
    return out;
  }

  app.get("/public/status", async (_req, reply) => {
    reply.header("cache-control", PUBLIC_CACHE);
    return { generatedAt: new Date(), monitors: await loadMonitors() };
  });

  const idParams = z.object({ id: z.uuid() });

  app.get("/public/monitors/:id", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const [monitor] = await loadMonitors(id);
    if (!monitor) throw notFound("Monitor não encontrado");
    reply.header("cache-control", PUBLIC_CACHE);
    return monitor;
  });

  const historyQuery = z.object({
    limit: z.coerce.number().int().min(1).max(HISTORY_MAX).default(HISTORY_DEFAULT),
    cursor: cursorSchema.optional(),
  });

  app.get("/public/monitors/:id/history", async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { limit, cursor } = historyQuery.parse(req.query);
    const exists = await db.monitor.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw notFound("Monitor não encontrado");

    const rows = await db.checkResult.findMany({
      where: {
        monitorId: id,
        ...(cursor && { OR: [{ checkedAt: { lt: cursor.at } }, { checkedAt: cursor.at, id: { lt: cursor.id } }] }),
      },
      orderBy: [{ checkedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: { id: true, checkedAt: true, success: true, statusCode: true, latencyMs: true, errorKind: true },
    });
    const { items, nextCursor } = paginate(rows, limit, (r) => encodeCursor(r.checkedAt, r.id));
    reply.header("cache-control", PUBLIC_CACHE);
    return {
      monitorId: id,
      checks: items.map(({ id: _id, ...check }) => check),
      nextCursor,
    };
  });

  const incidentsQuery = z.object({
    limit: z.coerce.number().int().min(1).max(INCIDENTS_MAX).default(INCIDENTS_DEFAULT),
    cursor: cursorSchema.optional(),
    monitorId: z.uuid().optional(),
    status: z.enum(["open", "resolved"]).optional(),
  });

  app.get("/public/incidents", async (req, reply) => {
    const { limit, cursor, monitorId, status } = incidentsQuery.parse(req.query);
    const rows = await db.incident.findMany({
      where: {
        ...(monitorId && { monitorId }),
        ...(status === "open" && { resolvedAt: null }),
        ...(status === "resolved" && { resolvedAt: { not: null } }),
        ...(cursor && { OR: [{ startedAt: { lt: cursor.at } }, { startedAt: cursor.at, id: { lt: cursor.id } }] }),
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: { id: true, monitorId: true, startedAt: true, resolvedAt: true, monitor: { select: { name: true } } },
    });
    const { items, nextCursor } = paginate(rows, limit, (r) => encodeCursor(r.startedAt, r.id));
    reply.header("cache-control", PUBLIC_CACHE);
    return {
      incidents: items.map((i) => ({
        id: i.id,
        monitorId: i.monitorId,
        monitorName: i.monitor.name,
        status: i.resolvedAt ? "resolved" : "open",
        startedAt: i.startedAt,
        resolvedAt: i.resolvedAt,
        durationSeconds: i.resolvedAt ? Math.round((i.resolvedAt.getTime() - i.startedAt.getTime()) / 1000) : null,
      })),
      nextCursor,
    };
  });
}
