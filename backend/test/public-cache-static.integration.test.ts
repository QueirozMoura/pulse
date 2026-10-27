import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { TEST_DB_URL, authed, login, mkMonitors, resetDb, seedAdmin, setup, validBody, type Ctx } from "./helpers.js";

const base = { DATABASE_URL: TEST_DB_URL ?? "postgresql://x@127.0.0.1:1/x", NODE_ENV: "development", LOG_LEVEL: "silent", SCHEDULER_ENABLED: "false" };

describe.skipIf(!TEST_DB_URL)("cache público e checkRounds (PostgreSQL real)", () => {
  let c: Ctx;
  beforeAll(async () => void (c = await setup()));
  afterAll(() => c.close());
  beforeEach(() => resetDb(c.db));

  it("checkRounds reflete a cadência do worker; null sem worker", async () => {
    const withW = buildApp(loadConfig({ ...base, WORKER_EXPECTED_INTERVAL_MINUTES: "15" }), c.db);
    expect((await withW.inject({ url: "/public/status" })).json().checkRounds).toEqual({ everyMinutes: 15 });
    expect((await c.app.inject({ url: "/public/status" })).json().checkRounds).toBeNull();
    await withW.close();
  });

  it("com cache: 2ª leitura não vai ao banco, generatedAt é sempre novo, mutação do admin invalida", async () => {
    await seedAdmin(c.db);
    const app = buildApp(loadConfig({ ...base, PUBLIC_CACHE_SECONDS: "60" }), c.db);
    const l = await login(app);
    await mkMonitors(c.db, 1, { prefix: "a" });
    const r1 = (await app.inject({ url: "/public/status" })).json();
    await mkMonitors(c.db, 1, { prefix: "b" }); // criado direto no banco: o cache não enxerga
    await new Promise((r) => setTimeout(r, 15));
    const r2res = await app.inject({ url: "/public/status" });
    const r2 = r2res.json();
    expect(r2.monitors).toHaveLength(1);
    expect(r2res.headers["cache-control"]).toBe("public, max-age=60");
    expect(new Date(r2.generatedAt).getTime()).toBeGreaterThan(new Date(r1.generatedAt).getTime());
    const created = await app.inject({ method: "POST", url: "/monitors", headers: authed(l), payload: validBody });
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ url: "/public/status" })).json().monitors).toHaveLength(3); // invalidado
    await app.close();
  });

  it("404 não entra no cache", async () => {
    const app = buildApp(loadConfig({ ...base, PUBLIC_CACHE_SECONDS: "60" }), c.db);
    const id = "5b5f3c4e-0f5e-4a3a-9e4c-5d2f1c7b8a90";
    expect((await app.inject({ url: `/public/monitors/${id}` })).statusCode).toBe(404);
    await app.close();
  });
});

describe("STATIC_DIR (mesma origem para o painel)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pulse-static-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>pulse-index</title>");
  writeFileSync(join(dir, "assets", "app-abc.js"), "console.log(1)");
  writeFileSync(join(dir, "..", "pulse-secret-outside.txt"), "segredo");
  // Sem banco: só rotas estáticas e 404, que não consultam o banco.
  const app = () => buildApp(loadConfig({ ...base, STATIC_DIR: dir }), {} as never);

  it("serve index nas rotas do SPA, com CSP e sem cache; assets imutáveis", async () => {
    const a = app();
    for (const url of ["/", "/s/abc", "/admin", "/admin/monitores"]) {
      const r = await a.inject({ url });
      expect(r.statusCode, url).toBe(200);
      expect(r.body).toContain("pulse-index");
      expect(r.headers["content-security-policy"]).toContain("default-src 'self'");
      expect(r.headers["x-frame-options"]).toBe("DENY");
      expect(r.headers["cache-control"]).toBe("no-cache");
    }
    const js = await a.inject({ url: "/assets/app-abc.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["cache-control"]).toContain("immutable");
    await a.close();
  });

  it("rotas de API desconhecidas continuam JSON 404 (sem cair no index) e path traversal não vaza", async () => {
    const a = app();
    const nf = await a.inject({ url: "/qualquer-coisa" });
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error).toBe("not_found");
    expect((await a.inject({ url: "/monitors" })).statusCode).toBe(401);
    for (const url of ["/../pulse-secret-outside.txt", "/%2e%2e/pulse-secret-outside.txt", "/assets/..%2f..%2fpulse-secret-outside.txt"]) {
      const r = await a.inject({ url });
      expect(r.body, url).not.toContain("segredo");
    }
    await a.close();
  });

  it("falha cedo se STATIC_DIR não tem index.html", () => {
    expect(() => buildApp(loadConfig({ ...base, STATIC_DIR: tmpdir() + "/nao-existe-xyz" }), {} as never)).toThrow(/index\.html/);
  });
});
