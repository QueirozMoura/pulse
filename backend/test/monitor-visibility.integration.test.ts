import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runWorkerOnce, type WorkerOptions } from "../src/worker/run-once.js";
import { TEST_DB_URL, authed, down, login, ok, resetDb, seedAdmin, setup, validBody, type Ctx, type Login } from "./helpers.js";

const NIL_UUID = "00000000-0000-4000-8000-000000000000";

describe.skipIf(!TEST_DB_URL)("visibilidade pública do monitor (PostgreSQL real)", () => {
  let c: Ctx;
  let l: Login;
  beforeAll(async () => void (c = await setup({ PUBLIC_CACHE_SECONDS: "60" })));
  afterAll(() => c.close());
  beforeEach(async () => {
    await resetDb(c.db);
    await seedAdmin(c.db);
    l = await login(c.app);
    // resetDb não passa pela API: uma escrita administrativa (404, sem efeito) esvazia o cache público entre os testes.
    await c.app.inject({ method: "POST", url: `/monitors/${NIL_UUID}/pause`, headers: authed(l) });
    await new Promise((r) => setTimeout(r, 20));
  });

  const admin = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
    c.app.inject({ method, url, payload: payload as object, headers: authed(l) });
  const pub = (url: string) => c.app.inject({ method: "GET", url });

  /** Um monitor público saudável e um interno com falhas e incidente resolvido (o "Teste de implantação"). */
  async function seed() {
    const now = Date.now();
    const shown = await c.db.monitor.create({ data: { name: "Visível", url: "https://visivel.example.com/", intervalSeconds: 900, lastCheckedAt: new Date(now) } });
    const hidden = await c.db.monitor.create({
      data: { name: "Interno", url: "https://interno.example.com/", intervalSeconds: 900, active: false, publicVisible: false, lastCheckedAt: new Date(now) },
    });
    await c.db.checkResult.createMany({
      data: [
        { monitorId: shown.id, checkedAt: new Date(now - 1000), success: true, statusCode: 200, latencyMs: 30 },
        { monitorId: hidden.id, checkedAt: new Date(now - 3000), success: false, latencyMs: 20, errorKind: "dns" },
        { monitorId: hidden.id, checkedAt: new Date(now - 2000), success: false, latencyMs: 20, errorKind: "dns" },
        { monitorId: hidden.id, checkedAt: new Date(now - 1000), success: true, statusCode: 200, latencyMs: 20 },
      ],
    });
    await c.db.incident.create({ data: { monitorId: hidden.id, startedAt: new Date(now - 3000), resolvedAt: new Date(now - 1000) } });
    await c.db.incident.create({ data: { monitorId: shown.id, startedAt: new Date(now - 9000), resolvedAt: new Date(now - 8000) } });
    return { shown, hidden };
  }

  describe("persistência e padrão", () => {
    it("monitores criados sem a opção continuam públicos (padrão true), na API e no banco", async () => {
      const res = await admin("POST", "/monitors", validBody);
      expect(res.statusCode).toBe(201);
      expect(res.json().publicVisible).toBe(true);
      expect((await c.db.monitor.findUniqueOrThrow({ where: { id: res.json().id } })).publicVisible).toBe(true);
      expect((await pub("/public/status")).json().monitors).toHaveLength(1);
    });

    it("cria e edita com publicVisible persistido; só aceita booleano", async () => {
      const created = (await admin("POST", "/monitors", { ...validBody, publicVisible: false })).json();
      expect(created.publicVisible).toBe(false);
      expect((await c.db.monitor.findUniqueOrThrow({ where: { id: created.id } })).publicVisible).toBe(false);

      const patched = await admin("PATCH", `/monitors/${created.id}`, { publicVisible: true });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().publicVisible).toBe(true);
      expect((await admin("GET", `/monitors/${created.id}`)).json().publicVisible).toBe(true);

      for (const bad of ["false", 0, null]) {
        expect((await admin("PATCH", `/monitors/${created.id}`, { publicVisible: bad })).statusCode).toBe(400);
      }
      expect((await admin("POST", "/monitors", { ...validBody, publicVisible: "no" })).statusCode).toBe(400);
    });
  });

  describe("exclusão das superfícies públicas", () => {
    it("GET /public/status não lista o monitor oculto e as contagens/uptime só consideram os visíveis", async () => {
      const { shown, hidden } = await seed();
      const body = (await pub("/public/status")).json();
      expect(body.monitors.map((m: { id: string }) => m.id)).toEqual([shown.id]);
      expect(body.monitors[0].uptime.last24h).toMatchObject({ checks: 1, successfulChecks: 1, percentage: 100 });
      const raw = JSON.stringify(body);
      expect(raw).not.toContain(hidden.id);
      expect(raw).not.toContain("Interno");
      expect(raw).not.toContain("interno.example.com");
    });

    it("GET /public/incidents não traz incidentes do monitor oculto, nem filtrando pelo id dele", async () => {
      const { shown, hidden } = await seed();
      const all = (await pub("/public/incidents")).json();
      expect(all.incidents.map((i: { monitorId: string }) => i.monitorId)).toEqual([shown.id]);
      expect(JSON.stringify(all)).not.toContain("Interno");
      for (const q of [`monitorId=${hidden.id}`, "status=resolved", "status=open"]) {
        const r = (await pub(`/public/incidents?${q}`)).json();
        expect(r.incidents.every((i: { monitorId: string }) => i.monitorId !== hidden.id)).toBe(true);
      }
      expect((await pub(`/public/incidents?monitorId=${hidden.id}`)).json().incidents).toEqual([]);
    });

    it("detalhe e histórico públicos do monitor oculto respondem 404, igual a um id inexistente", async () => {
      const { shown, hidden } = await seed();
      const missing = await pub(`/public/monitors/${NIL_UUID}`);
      const detail = await pub(`/public/monitors/${hidden.id}`);
      const history = await pub(`/public/monitors/${hidden.id}/history`);
      expect([detail.statusCode, history.statusCode]).toEqual([404, 404]);
      const { requestId: _a, ...detailBody } = detail.json();
      const { requestId: _b, ...missingBody } = missing.json();
      expect(detailBody).toEqual(missingBody); // não revela que o id existe
      expect((await pub(`/public/monitors/${shown.id}`)).statusCode).toBe(200);
      expect((await pub(`/public/monitors/${shown.id}/history`)).statusCode).toBe(200);
    });

    it("a paginação do histórico do monitor oculto também é 404", async () => {
      const { hidden } = await seed();
      expect((await pub(`/public/monitors/${hidden.id}/history?limit=1`)).statusCode).toBe(404);
    });
  });

  describe("acesso administrativo e agendamento", () => {
    it("o painel autenticado lista e detalha o monitor oculto, com URL e histórico preservado", async () => {
      const { hidden } = await seed();
      const list = (await admin("GET", "/monitors")).json().monitors as { id: string; publicVisible: boolean; url: string }[];
      expect(list.find((m) => m.id === hidden.id)).toMatchObject({ publicVisible: false, url: "https://interno.example.com/" });
      expect((await admin("GET", `/monitors/${hidden.id}`)).statusCode).toBe(200);
      expect(await c.db.checkResult.count({ where: { monitorId: hidden.id } })).toBe(3);
      expect(await c.db.incident.count({ where: { monitorId: hidden.id } })).toBe(1);
    });

    it("sem login, o monitor oculto continua inacessível pelas rotas administrativas", async () => {
      const { hidden } = await seed();
      expect((await c.app.inject({ method: "GET", url: `/monitors/${hidden.id}` })).statusCode).toBe(401);
      expect((await c.app.inject({ method: "PATCH", url: `/monitors/${hidden.id}`, payload: { publicVisible: true } })).statusCode).toBe(401);
      expect((await c.db.monitor.findUniqueOrThrow({ where: { id: hidden.id } })).publicVisible).toBe(false);
    });

    it("alternar a visibilidade não muda pausa, agendamento nem checagens, e vale na hora apesar do cache", async () => {
      const m = (await admin("POST", "/monitors", validBody)).json();
      await admin("POST", `/monitors/${m.id}/pause`);
      const before = await c.db.monitor.findUniqueOrThrow({ where: { id: m.id } });
      expect((await pub("/public/status")).json().monitors).toHaveLength(1); // aquece o cache

      await admin("PATCH", `/monitors/${m.id}`, { publicVisible: false });
      expect((await pub("/public/status")).json().monitors).toHaveLength(0); // cache invalidado
      expect((await pub(`/public/monitors/${m.id}`)).statusCode).toBe(404);

      const after = await c.db.monitor.findUniqueOrThrow({ where: { id: m.id } });
      expect(after.active).toBe(false);
      expect(after.nextCheckAt).toEqual(before.nextCheckAt);
      expect(after.intervalSeconds).toBe(before.intervalSeconds);
      expect(after.url).toBe(before.url);

      await admin("PATCH", `/monitors/${m.id}`, { publicVisible: true });
      expect((await pub("/public/status")).json().monitors).toHaveLength(1);
    });

    it("o worker continua checando e registrando incidentes de um monitor oculto (e ele segue fora do público)", async () => {
      const hidden = await c.db.monitor.create({
        data: { name: "Oculto ativo", url: "https://oculto.example.com/", intervalSeconds: 900, publicVisible: false, nextCheckAt: new Date(Date.now() - 1000) },
      });
      const opts = (check: WorkerOptions["check"]): WorkerOptions => ({
        timeoutMs: 20_000, maxChecks: 200, concurrency: 5, checkTimeoutMs: 1000, dueSlackSeconds: 0, retentionDays: 30, alerts: null, check,
      });
      const r1 = await runWorkerOnce(c.db, c.app.log, opts(async () => ok));
      expect(r1.checks).toMatchObject({ claimed: 1, recorded: 1 });
      await c.db.monitor.update({ where: { id: hidden.id }, data: { nextCheckAt: new Date(Date.now() - 1000) } });
      await runWorkerOnce(c.db, c.app.log, opts(async () => down));
      await c.db.monitor.update({ where: { id: hidden.id }, data: { nextCheckAt: new Date(Date.now() - 1000) } });
      await runWorkerOnce(c.db, c.app.log, opts(async () => down));

      expect(await c.db.checkResult.count({ where: { monitorId: hidden.id } })).toBe(3);
      expect(await c.db.incident.count({ where: { monitorId: hidden.id, resolvedAt: null } })).toBe(1);
      expect((await pub("/public/status")).json().monitors).toEqual([]);
      expect((await pub("/public/incidents")).json().incidents).toEqual([]);
    });
  });
});
