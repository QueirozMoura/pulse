import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_DB_URL, authed, login, resetDb, seedAdmin, setup, type Ctx } from "./helpers.js";

describe.skipIf(!TEST_DB_URL)("limites de cadastro (PostgreSQL real)", () => {
  const body = (n: number, intervalSeconds = 60) => ({ name: `m${n}`, url: `https://site${n}.example.com`, intervalSeconds });

  describe("MAX_MONITORS", () => {
    let c: Ctx;
    beforeAll(async () => void (c = await setup({ MAX_MONITORS: "2" })));
    afterAll(() => c.close());
    beforeEach(async () => {
      await resetDb(c.db);
      await seedAdmin(c.db);
    });

    it("recusa o monitor além do teto com 409 monitor_limit_reached", async () => {
      const l = await login(c.app);
      const post = (n: number) => c.app.inject({ method: "POST", url: "/monitors", payload: body(n), headers: authed(l) });
      expect((await post(1)).statusCode).toBe(201);
      expect((await post(2)).statusCode).toBe(201);
      const third = await post(3);
      expect(third.statusCode).toBe(409);
      expect(third.json().error).toBe("monitor_limit_reached");
      expect(await c.db.monitor.count()).toBe(2);
    });

    it("a listagem administrativa fica limitada pelo teto", async () => {
      const l = await login(c.app);
      for (const n of [1, 2]) await c.app.inject({ method: "POST", url: "/monitors", payload: body(n), headers: authed(l) });
      const list = await c.app.inject({ method: "GET", url: "/monitors", headers: { cookie: l.cookie } });
      expect(list.json().monitors.length).toBeLessThanOrEqual(2);
    });
  });

  describe("intervalo × timeout", () => {
    let c: Ctx;
    beforeAll(async () => void (c = await setup({ CHECK_TIMEOUT_MS: "45000", MIN_INTERVAL_SECONDS: "30" })));
    afterAll(() => c.close());
    beforeEach(async () => {
      await resetDb(c.db);
      await seedAdmin(c.db);
    });

    it("o intervalo precisa ser maior que o timeout (a checagem anterior sempre termina antes da próxima)", async () => {
      const l = await login(c.app);
      const post = (i: number) => c.app.inject({ method: "POST", url: "/monitors", payload: body(i, i), headers: authed(l) });
      expect((await post(45)).statusCode).toBe(400);
      expect((await post(46)).statusCode).toBe(201);
      const m = (await c.db.monitor.findFirstOrThrow()).id;
      const patch = await c.app.inject({ method: "PATCH", url: `/monitors/${m}`, payload: { intervalSeconds: 40 }, headers: authed(l) });
      expect(patch.statusCode).toBe(400);
    });
  });
});
