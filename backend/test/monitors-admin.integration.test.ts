import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_DB_URL, authed, login, resetDb, seedAdmin, setup, validBody, type Ctx, type Login } from "./helpers.js";

describe.skipIf(!TEST_DB_URL)("administração de monitores (PostgreSQL real)", () => {
  let c: Ctx;
  let l: Login;
  beforeAll(async () => void (c = await setup()));
  afterAll(() => c.close());
  beforeEach(async () => {
    await resetDb(c.db);
    await seedAdmin(c.db);
    l = await login(c.app);
  });

  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, headers = authed(l)) =>
    c.app.inject({ method, url, payload: payload as object, headers });
  const create = async (body: object = validBody) => (await call("POST", "/monitors", body)).json();

  describe("sem login", () => {
    it("nenhuma operação administrativa funciona", async () => {
      const m = await create();
      const none = {} as Record<string, string>;
      const attempts = [
        c.app.inject({ method: "POST", url: "/monitors", payload: validBody, headers: none }),
        c.app.inject({ method: "GET", url: "/monitors", headers: none }),
        c.app.inject({ method: "GET", url: `/monitors/${m.id}`, headers: none }),
        c.app.inject({ method: "PATCH", url: `/monitors/${m.id}`, payload: { name: "hack" }, headers: none }),
        c.app.inject({ method: "POST", url: `/monitors/${m.id}/pause`, headers: none }),
        c.app.inject({ method: "POST", url: `/monitors/${m.id}/resume`, headers: none }),
        c.app.inject({ method: "DELETE", url: `/monitors/${m.id}`, headers: none }),
      ];
      expect((await Promise.all(attempts)).map((r) => r.statusCode)).toEqual(Array(7).fill(401));
      const row = await c.db.monitor.findUniqueOrThrow({ where: { id: m.id } });
      expect(row.name).toBe(validBody.name);
      expect(row.active).toBe(true);
    });
  });

  describe("cadastro e leitura", () => {
    it("cria (201), lista e busca por id", async () => {
      const res = await call("POST", "/monitors", validBody);
      expect(res.statusCode).toBe(201);
      const m = res.json();
      expect(m).toMatchObject({ name: "Site", url: "https://example.com/", intervalSeconds: 60, active: true, status: "OPERATIONAL" });
      expect((await call("GET", "/monitors")).json().monitors).toHaveLength(1);
      expect((await call("GET", `/monitors/${m.id}`)).json().id).toBe(m.id);
    });

    it.each([
      ["http (sem TLS)", { url: "http://example.com" }],
      ["localhost", { url: "https://localhost/x" }],
      ["IP de metadados", { url: "https://169.254.169.254/latest" }],
      ["IP decimal", { url: "https://2130706433/" }],
      ["IPv6 mapeado", { url: "https://[::ffff:7f00:1]/" }],
      ["credenciais na URL", { url: "https://u:p@example.com" }],
      ["intervalo abaixo do mínimo", { intervalSeconds: 5 }],
      ["intervalo acima do máximo", { intervalSeconds: 999999 }],
      ["nome vazio", { name: "   " }],
      ["campo desconhecido (mass assignment)", { status: "UNAVAILABLE" }],
      ["campo desconhecido active", { active: false }],
    ])("rejeita no cadastro: %s", async (_label, patch) => {
      const res = await call("POST", "/monitors", { ...validBody, ...patch });
      expect(res.statusCode).toBe(400);
      expect(await c.db.monitor.count()).toBe(0);
    });

    it("corpo ausente ou JSON inválido → 400, nunca 500", async () => {
      expect((await call("POST", "/monitors")).statusCode).toBe(400);
      const bad = await c.app.inject({ method: "POST", url: "/monitors", payload: "{nope", headers: authed(l, { "content-type": "application/json" }) });
      expect(bad.statusCode).toBe(400);
    });

    it("id inválido → 400; inexistente → 404", async () => {
      expect((await call("GET", "/monitors/abc")).statusCode).toBe(400);
      expect((await call("GET", "/monitors/00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
    });
  });

  describe("edição", () => {
    it("altera nome e intervalo", async () => {
      const m = await create();
      const res = await call("PATCH", `/monitors/${m.id}`, { name: "Novo nome", intervalSeconds: 120 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: "Novo nome", intervalSeconds: 120, url: "https://example.com/" });
    });

    it("trocar a URL agenda checagem imediata", async () => {
      const m = await create();
      await c.db.monitor.update({ where: { id: m.id }, data: { nextCheckAt: new Date(Date.now() + 3_600_000) } });
      const res = await call("PATCH", `/monitors/${m.id}`, { url: "https://example.org/status" });
      expect(res.json().url).toBe("https://example.org/status");
      expect(new Date(res.json().nextCheckAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it("reduzir o intervalo antecipa a próxima checagem", async () => {
      const m = await create({ ...validBody, intervalSeconds: 86400 });
      await c.db.monitor.update({ where: { id: m.id }, data: { nextCheckAt: new Date(Date.now() + 86_400_000) } });
      const res = await call("PATCH", `/monitors/${m.id}`, { intervalSeconds: 30 });
      expect(new Date(res.json().nextCheckAt).getTime()).toBeLessThanOrEqual(Date.now() + 31_000);
    });

    it.each([
      ["http", { url: "http://example.com" }],
      ["localhost", { url: "https://localhost" }],
      ["IP interno", { url: "https://10.0.0.1/" }],
      ["IPv6 ULA", { url: "https://[fd00::1]/" }],
      ["corpo vazio", {}],
      ["mass assignment: status", { status: "UNAVAILABLE" }],
      ["mass assignment: id", { id: "00000000-0000-4000-8000-000000000000" }],
      ["mass assignment: consecutiveFailures", { consecutiveFailures: 99 }],
    ])("as validações de URL/entrada se mantêm na edição: %s", async (_l, payload) => {
      const m = await create();
      expect((await call("PATCH", `/monitors/${m.id}`, payload)).statusCode).toBe(400);
      const row = await c.db.monitor.findUniqueOrThrow({ where: { id: m.id } });
      expect(row.url).toBe("https://example.com/");
      expect(row.status).toBe("OPERATIONAL");
    });

    it("editar monitor inexistente → 404", async () => {
      expect((await call("PATCH", "/monitors/00000000-0000-4000-8000-000000000000", { name: "x" })).statusCode).toBe(404);
    });
  });

  describe("pausa e retomada", () => {
    it("pausar tira o monitor do agendamento e o mostra como 'paused' no público; retomar devolve", async () => {
      const m = await create();
      const paused = await call("POST", `/monitors/${m.id}/pause`);
      expect(paused.statusCode).toBe(200);
      expect(paused.json().active).toBe(false);

      // fora do agendamento: a query do scheduler não o reivindica
      await c.db.monitor.update({ where: { id: m.id }, data: { nextCheckAt: new Date(Date.now() - 60_000) } });
      const claimed = await c.db.$queryRaw<{ id: string }[]>`
        SELECT id FROM monitors WHERE active AND next_check_at <= (now() AT TIME ZONE 'UTC')`;
      expect(claimed).toHaveLength(0);

      const pub = await c.app.inject({ method: "GET", url: "/public/status" });
      expect(pub.json().monitors.map((x: { state: string }) => x.state)).toEqual(["paused"]);

      const resumed = await call("POST", `/monitors/${m.id}/resume`);
      expect(resumed.json().active).toBe(true);
      const again = await c.db.$queryRaw<{ id: string }[]>`
        SELECT id FROM monitors WHERE active AND next_check_at <= (now() AT TIME ZONE 'UTC') + interval '1 second'`;
      expect(again).toHaveLength(1);
    });

    it("pausa é idempotente e funciona com Content-Type JSON e corpo vazio", async () => {
      const m = await create();
      const h = authed(l, { "content-type": "application/json" });
      expect((await c.app.inject({ method: "POST", url: `/monitors/${m.id}/pause`, headers: h })).statusCode).toBe(200);
      expect((await c.app.inject({ method: "POST", url: `/monitors/${m.id}/pause`, headers: h })).statusCode).toBe(200);
    });
  });

  describe("exclusão", () => {
    it("remove o monitor e, em cascata, checagens e incidentes", async () => {
      const m = await create();
      await c.db.checkResult.create({ data: { monitorId: m.id, success: false, latencyMs: 10, errorKind: "dns" } });
      await c.db.incident.create({ data: { monitorId: m.id } });
      const res = await call("DELETE", `/monitors/${m.id}`);
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");
      expect(await c.db.monitor.count()).toBe(0);
      expect(await c.db.checkResult.count()).toBe(0);
      expect(await c.db.incident.count()).toBe(0);
      expect((await call("GET", `/monitors/${m.id}`)).statusCode).toBe(404);
      expect((await call("DELETE", `/monitors/${m.id}`)).statusCode).toBe(404);
    });
  });

  describe("rotas públicas seguem abertas", () => {
    it("status e histórico funcionam sem login e não vazam a URL", async () => {
      const m = await create({ ...validBody, url: "https://example.com/segredo?token=abc" });
      await c.db.checkResult.create({ data: { monitorId: m.id, success: true, statusCode: 200, latencyMs: 12 } });
      const status = await c.app.inject({ method: "GET", url: "/public/status" });
      const history = await c.app.inject({ method: "GET", url: `/public/monitors/${m.id}/history` });
      expect([status.statusCode, history.statusCode]).toEqual([200, 200]);
      for (const body of [status.body, history.body]) {
        expect(body).not.toMatch(/example\.com|segredo|token=abc|"url"/);
      }
      expect(status.json().monitors).toHaveLength(1);
      expect(c.app.routeTable.length).toBeGreaterThan(0);
    });

    it("/health continua público", async () => {
      expect((await c.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    });
  });
});
