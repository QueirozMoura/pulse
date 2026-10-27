import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_DB_URL, mkMonitors, resetDb, setup, type Ctx } from "./helpers.js";

const H = 3_600_000;
const D = 24 * H;

describe.skipIf(!TEST_DB_URL)("API pública (PostgreSQL real)", () => {
  let c: Ctx;
  beforeAll(async () => void (c = await setup()));
  afterAll(() => c.close());
  beforeEach(() => resetDb(c.db));

  const get = async (url: string) => {
    const res = await c.app.inject({ method: "GET", url });
    return { status: res.statusCode, body: res.json(), res };
  };
  const addChecks = (monitorId: string, rows: { agoMs: number; success: boolean; latencyMs?: number; errorKind?: string | null; statusCode?: number | null }[]) =>
    c.db.checkResult.createMany({
      data: rows.map((r) => ({
        monitorId,
        checkedAt: new Date(Date.now() - r.agoMs),
        success: r.success,
        latencyMs: r.latencyMs ?? 25,
        statusCode: r.statusCode ?? (r.success ? 200 : null),
        errorKind: r.errorKind ?? (r.success ? null : "timeout"),
      })),
    });

  describe("GET /public/status: os quatro estados", () => {
    it("distingue operacional, indisponível, pausado e ainda-sem-dados", async () => {
      const [op, un, pa, nd] = await mkMonitors(c.db, 4);
      await addChecks(op!.id, [{ agoMs: 1000, success: true, latencyMs: 42 }]);
      await c.db.monitor.update({ where: { id: op!.id }, data: { lastCheckedAt: new Date(Date.now() - 1000) } });
      await addChecks(un!.id, [{ agoMs: 2000, success: false }, { agoMs: 1000, success: false }]);
      await c.db.monitor.update({ where: { id: un!.id }, data: { status: "UNAVAILABLE", consecutiveFailures: 2, lastCheckedAt: new Date(Date.now() - 1000) } });
      await c.db.incident.create({ data: { monitorId: un!.id, startedAt: new Date(Date.now() - 1000) } });
      await c.db.monitor.update({ where: { id: pa!.id }, data: { active: false, lastCheckedAt: new Date() } });

      const { status, body } = await get("/public/status");
      expect(status).toBe(200);
      const by = Object.fromEntries(body.monitors.map((m: { name: string }) => [m.name, m]));
      expect(by.m0.state).toBe("operational");
      expect(by.m1.state).toBe("unavailable");
      expect(by.m2.state).toBe("paused");
      expect(by.m3.state).toBe("no_data");
      expect(nd!.id).toBe(by.m3.id);
      expect(typeof body.generatedAt).toBe("string");
    });

    it("operacional: última checagem com latência e status HTTP; sem incidente aberto", async () => {
      const [m] = await mkMonitors(c.db, 1);
      await addChecks(m!.id, [{ agoMs: 5000, success: true, latencyMs: 90 }, { agoMs: 1000, success: true, latencyMs: 42 }]);
      await c.db.monitor.update({ where: { id: m!.id }, data: { lastCheckedAt: new Date() } });
      const { body } = await get("/public/status");
      expect(body.monitors[0].lastCheck).toMatchObject({ success: true, statusCode: 200, latencyMs: 42, errorKind: null });
      expect(body.monitors[0].ongoingIncident).toBeNull();
    });

    it("indisponível: expõe o incidente aberto e a categoria (não a mensagem) da falha", async () => {
      const [m] = await mkMonitors(c.db, 1);
      await addChecks(m!.id, [{ agoMs: 1000, success: false, errorKind: "tls" }]);
      await c.db.monitor.update({ where: { id: m!.id }, data: { status: "UNAVAILABLE", lastCheckedAt: new Date() } });
      const inc = await c.db.incident.create({ data: { monitorId: m!.id, startedAt: new Date(Date.now() - 60_000) } });
      const { body } = await get("/public/status");
      expect(body.monitors[0].lastCheck).toMatchObject({ success: false, statusCode: null, errorKind: "tls" });
      expect(body.monitors[0].ongoingIncident).toEqual({ id: inc.id, startedAt: inc.startedAt.toISOString() });
    });

    it("sem-dados: lastCheck nulo e uptime NULO, nunca 100% inventado", async () => {
      await mkMonitors(c.db, 1);
      const { body } = await get("/public/status");
      const m = body.monitors[0];
      expect(m.state).toBe("no_data");
      expect(m.lastCheck).toBeNull();
      expect(m.uptime.last24h).toEqual({ checks: 0, successfulChecks: 0, percentage: null });
      expect(m.uptime.last7d).toEqual({ checks: 0, successfulChecks: 0, percentage: null });
    });

    it("uptime: janelas de 24h e 7d separadas, com o tamanho da amostra", async () => {
      const [m] = await mkMonitors(c.db, 1);
      await addChecks(m!.id, [
        ...Array.from({ length: 5 }, (_, i) => ({ agoMs: (i + 1) * H, success: true })), // 5 ok nas últimas 24h
        { agoMs: 2 * H + 1000, success: false }, // 1 falha nas últimas 24h
        { agoMs: 3 * D, success: false }, // fora de 24h, dentro de 7d
        { agoMs: 3 * D + H, success: false },
        { agoMs: 10 * D, success: false }, // fora das duas janelas
      ]);
      const { body } = await get("/public/status");
      expect(body.monitors[0].uptime.last24h).toEqual({ checks: 6, successfulChecks: 5, percentage: 83.33 });
      expect(body.monitors[0].uptime.last7d).toEqual({ checks: 8, successfulChecks: 5, percentage: 62.5 });
    });

    it("pausado mantém o histórico de uptime; é só o estado que muda", async () => {
      const [m] = await mkMonitors(c.db, 1);
      await addChecks(m!.id, [{ agoMs: H, success: true }]);
      await c.db.monitor.update({ where: { id: m!.id }, data: { active: false, lastCheckedAt: new Date() } });
      const { body } = await get("/public/status");
      expect(body.monitors[0].state).toBe("paused");
      expect(body.monitors[0].uptime.last24h.percentage).toBe(100);
    });

    it("lista vazia é uma resposta válida", async () => {
      expect((await get("/public/status")).body.monitors).toEqual([]);
    });
  });

  describe("GET /public/monitors/:id", () => {
    it("devolve o mesmo item da lista; 404 para inexistente, 400 para id inválido", async () => {
      const [m] = await mkMonitors(c.db, 1);
      const list = (await get("/public/status")).body.monitors[0];
      const one = await get(`/public/monitors/${m!.id}`);
      expect(one.status).toBe(200);
      expect(one.body).toEqual(list);
      expect((await get("/public/monitors/00000000-0000-4000-8000-000000000000")).status).toBe(404);
      expect((await get("/public/monitors/abc")).status).toBe(400);
    });
  });

  describe("GET /public/monitors/:id/history: paginação", () => {
    it("percorre tudo por cursor, sem repetir nem pular, inclusive com timestamps idênticos", async () => {
      const [m] = await mkMonitors(c.db, 1);
      const same = new Date(Date.now() - 10 * H);
      await c.db.checkResult.createMany({
        data: [
          ...Array.from({ length: 3 }, () => ({ monitorId: m!.id, checkedAt: same, success: true, latencyMs: 1 })), // empate
          ...Array.from({ length: 22 }, (_, i) => ({ monitorId: m!.id, checkedAt: new Date(Date.now() - (i + 1) * 60_000), success: i % 4 !== 0, latencyMs: 10 + i })),
        ],
      });

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const { status, body } = await get(`/public/monitors/${m!.id}/history?limit=10${cursor ? `&cursor=${cursor}` : ""}`);
        expect(status).toBe(200);
        expect(body.checks.length).toBeLessThanOrEqual(10);
        for (const ch of body.checks) seen.push(`${ch.checkedAt}|${ch.latencyMs}`);
        cursor = body.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toHaveLength(25);
      // ordem: mais recente primeiro
      const times = seen.map((s) => Date.parse(s.split("|")[0]!));
      expect(times).toEqual([...times].sort((a, b) => b - a));
      // sem linhas repetidas (os 3 empates têm latência igual, mas só 3 deles existem)
      expect(seen.filter((s) => s.endsWith("|1"))).toHaveLength(3);
    });

    it("última página não traz cursor; resposta não vaza ids internos", async () => {
      const [m] = await mkMonitors(c.db, 1);
      await addChecks(m!.id, [{ agoMs: 1000, success: true }]);
      const { body } = await get(`/public/monitors/${m!.id}/history`);
      expect(body.nextCursor).toBeNull();
      expect(Object.keys(body.checks[0]).sort()).toEqual(["checkedAt", "errorKind", "latencyMs", "statusCode", "success"]);
    });

    it("padrão de 50 e teto de 200; fora dos limites é 400", async () => {
      const [m] = await mkMonitors(c.db, 1);
      await c.db.checkResult.createMany({
        data: Array.from({ length: 260 }, (_, i) => ({ monitorId: m!.id, checkedAt: new Date(Date.now() - i * 1000), success: true, latencyMs: 1 })),
      });
      expect((await get(`/public/monitors/${m!.id}/history`)).body.checks).toHaveLength(50);
      expect((await get(`/public/monitors/${m!.id}/history?limit=200`)).body.checks).toHaveLength(200);
      for (const bad of ["limit=201", "limit=0", "limit=-1", "limit=abc", "limit=1.5", "cursor=lixo"]) {
        const r = await get(`/public/monitors/${m!.id}/history?${bad}`);
        expect(r.status, bad).toBe(400);
        expect(r.body.error).toBe("validation_error");
      }
    });

    it("monitor inexistente → 404", async () => {
      expect((await get("/public/monitors/00000000-0000-4000-8000-000000000000/history")).status).toBe(404);
    });
  });

  describe("GET /public/incidents", () => {
    it("lista abertos e resolvidos com duração; filtra por status e por monitor; pagina", async () => {
      const [a, b] = await mkMonitors(c.db, 2);
      const t = (agoMs: number) => new Date(Date.now() - agoMs);
      await c.db.incident.createMany({
        data: [
          { monitorId: a!.id, startedAt: t(5 * D), resolvedAt: new Date(t(5 * D).getTime() + 90_000) },
          { monitorId: a!.id, startedAt: t(3 * D), resolvedAt: new Date(t(3 * D).getTime() + 600_000) },
          { monitorId: b!.id, startedAt: t(2 * D), resolvedAt: new Date(t(2 * D).getTime() + 30_000) },
          { monitorId: b!.id, startedAt: t(1 * H) }, // aberto
        ],
      });

      const all = (await get("/public/incidents")).body;
      expect(all.incidents).toHaveLength(4);
      expect(all.nextCursor).toBeNull();
      expect(all.incidents[0]).toMatchObject({ monitorName: "m1", status: "open", resolvedAt: null, durationSeconds: null });
      expect(all.incidents[1]).toMatchObject({ monitorName: "m1", status: "resolved", durationSeconds: 30 });
      expect(all.incidents[2].durationSeconds).toBe(600);
      expect(all.incidents[3].durationSeconds).toBe(90);

      expect((await get("/public/incidents?status=open")).body.incidents).toHaveLength(1);
      expect((await get("/public/incidents?status=resolved")).body.incidents).toHaveLength(3);
      expect((await get(`/public/incidents?monitorId=${a!.id}`)).body.incidents).toHaveLength(2);

      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { body: { incidents: { id: string }[]; nextCursor: string | null } } = await get(`/public/incidents?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
        ids.push(...page.body.incidents.map((i) => i.id));
        cursor = page.body.nextCursor;
      } while (cursor);
      expect(new Set(ids).size).toBe(4);
    });

    it("padrão de 20, teto de 100 e entradas inválidas são recusadas", async () => {
      const [m] = await mkMonitors(c.db, 1);
      await c.db.incident.createMany({
        data: Array.from({ length: 130 }, (_, i) => ({ monitorId: m!.id, startedAt: new Date(Date.now() - (i + 1) * 1000), resolvedAt: new Date(Date.now() - i * 1000) })),
      });
      expect((await get("/public/incidents")).body.incidents).toHaveLength(20);
      expect((await get("/public/incidents?limit=100")).body.incidents).toHaveLength(100);
      for (const bad of ["limit=101", "limit=0", "status=foo", "monitorId=x", "cursor=x"]) {
        expect((await get(`/public/incidents?${bad}`)).status, bad).toBe(400);
      }
    });

    it("incidente de monitor pausado continua visível, e o de monitor excluído some junto", async () => {
      const [a, b] = await mkMonitors(c.db, 2);
      await c.db.incident.createMany({ data: [{ monitorId: a!.id }, { monitorId: b!.id, startedAt: new Date(Date.now() - 1000) }] });
      await c.db.monitor.update({ where: { id: a!.id }, data: { active: false } });
      expect((await get("/public/incidents")).body.incidents).toHaveLength(2);
      await c.db.monitor.delete({ where: { id: b!.id } });
      expect((await get("/public/incidents")).body.incidents).toHaveLength(1);
    });
  });

  describe("nada de interno nas rotas públicas", () => {
    // Contrato fechado: qualquer campo novo numa rota pública quebra este teste até ser decidido de forma consciente.
    const ALLOWED_KEYS = new Set([
      "status", "scheduler", "worker", "lastSuccessAt", "ageSeconds", "expectedEveryMinutes", "lateAfterMinutes", "lastRun", // /health
      "checkRounds", "everyMinutes", // /public/status
      "generatedAt", "monitors", "id", "name", "state", "monitoringSince", "lastCheck", "ongoingIncident", "uptime",
      "checkedAt", "success", "statusCode", "latencyMs", "errorKind", "startedAt", "last24h", "last7d", "checks", "successfulChecks", "percentage",
      "monitorId", "nextCursor", "incidents", "monitorName", "resolvedAt", "durationSeconds",
      "error", "message", "requestId", "issues", "path",
    ]);
    const keysOf = (v: unknown, out = new Set<string>()): Set<string> => {
      if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.add(k), keysOf(x, out));
      return out;
    };

    it("URL, host, token e erros brutos não aparecem; só chaves permitidas", async () => {
      const [m] = await mkMonitors(c.db, 1);
      await c.db.monitor.update({
        where: { id: m!.id },
        data: { url: "https://segredo-interno.example.net/admin?token=SUPERSECRETO", status: "UNAVAILABLE", consecutiveFailures: 7, lastCheckedAt: new Date() },
      });
      await addChecks(m!.id, [{ agoMs: 2000, success: false, errorKind: "dns" }, { agoMs: 1000, success: false, errorKind: "connection" }]);
      await c.db.incident.create({ data: { monitorId: m!.id } });

      const urls = [
        "/health", "/public/status", `/public/monitors/${m!.id}`, `/public/monitors/${m!.id}/history`, "/public/incidents",
        "/public/monitors/00000000-0000-4000-8000-000000000000", "/public/monitors/abc/history", "/public/incidents?limit=999", "/nao-existe",
      ];
      const keys = new Set<string>();
      for (const u of urls) {
        const { body, res } = await get(u);
        const text = res.body;
        expect(text, u).not.toMatch(/segredo|SUPERSECRETO|token=|example\.net|ECONN|ENOTFOUND|getaddrinfo|prisma|postgres|DATABASE_URL|scrypt|stack|at .*\.ts/i);
        keysOf(body, keys);
      }
      const unexpected = [...keys].filter((k) => !ALLOWED_KEYS.has(k));
      expect(unexpected).toEqual([]);
      for (const hidden of ["url", "consecutiveFailures", "nextCheckAt", "intervalSeconds", "active", "uptimeSeconds"]) {
        expect(keys.has(hidden), hidden).toBe(false);
      }
    });

    it("rotas públicas respondem com cache curto e cabeçalhos de segurança; erros não são cacheados", async () => {
      const [m] = await mkMonitors(c.db, 1);
      const ok = (await get("/public/status")).res;
      expect(ok.headers["cache-control"]).toBe("public, max-age=10");
      expect(ok.headers["x-content-type-options"]).toBe("nosniff");
      expect(ok.headers["x-request-id"]).toBeTruthy();
      expect((await get(`/public/monitors/${m!.id}/history?limit=0`)).res.headers["cache-control"]).toBeUndefined();
      expect((await get("/health")).res.headers["cache-control"]).toBe("no-store");
    });
  });
});
