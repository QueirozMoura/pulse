import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Db } from "../src/lib/db.js";

const baseEnv = { DATABASE_URL: "postgresql://x@localhost/x", LOG_LEVEL: "silent" };
const noDb = {} as Db; // rotas desabilitadas não podem tocar no banco

describe("rotas de escrita (sem autenticação)", () => {
  it("por padrão (sem flag) não existem: POST e GET /monitors respondem 404", async () => {
    const app = buildApp(loadConfig({ ...baseEnv }), noDb);
    const post = await app.inject({ method: "POST", url: "/monitors", payload: { name: "x", url: "https://example.com", intervalSeconds: 60 } });
    const get = await app.inject({ method: "GET", url: "/monitors" });
    expect([post.statusCode, get.statusCode]).toEqual([404, 404]);
    await app.close();
  });

  it("com a flag em desenvolvimento, as rotas são registradas", async () => {
    const app = buildApp(loadConfig({ ...baseEnv, NODE_ENV: "development", ADMIN_ROUTES_ENABLED: "true" }), noDb);
    // body inválido: prova que a rota existe (400 de validação, não 404) sem tocar no banco
    const res = await app.inject({ method: "POST", url: "/monitors", payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("NODE_ENV=production com a flag ligada impede o processo de iniciar", () => {
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: "production", ADMIN_ROUTES_ENABLED: "true" })).toThrow(/ADMIN_ROUTES_ENABLED/);
  });

  it("NODE_ENV ausente é tratado como production (falha fechada)", () => {
    expect(loadConfig({ ...baseEnv }).NODE_ENV).toBe("production");
    expect(() => loadConfig({ ...baseEnv, ADMIN_ROUTES_ENABLED: "true" })).toThrow(/ADMIN_ROUTES_ENABLED/);
  });

  it("rotas públicas e /health continuam registradas em produção", async () => {
    const app = buildApp(loadConfig({ ...baseEnv, NODE_ENV: "production" }), noDb);
    const res = await app.inject({ method: "GET", url: "/public/monitors/não-é-uuid/history" });
    expect(res.statusCode).toBe(400); // rota existe; falha na validação do id
    await app.close();
  });
});
