import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Db } from "../src/lib/db.js";

const env = { DATABASE_URL: "postgresql://x@localhost/x", LOG_LEVEL: "silent" };
// Sem sessão válida nada deve chegar a consultar além disto.
const stubDb = { session: { findUnique: async () => null } } as unknown as Db;

/** Rotas que podem ser acessadas sem login. Qualquer rota nova fora desta lista TEM que exigir sessão. */
const PUBLIC = new Set([
  "GET /health",
  "GET /health/live",
  "GET /public/status",
  "GET /public/monitors/:id",
  "GET /public/monitors/:id/history",
  "GET /public/incidents",
  "POST /auth/login",
]);

describe("nenhuma rota administrativa é acessível sem login", () => {
  const app = buildApp(loadConfig({ ...env, NODE_ENV: "production" }), stubDb);

  it("toda rota fora da lista pública está no escopo protegido e responde 401 sem sessão", async () => {
    await app.ready();
    const routes = app.routeTable.filter((r) => !PUBLIC.has(`${r.method} ${r.url}`));
    expect(routes.length).toBeGreaterThanOrEqual(8); // monitors (7) + session/logout: guarda contra teste vazio

    for (const r of routes) {
      expect(r.protected, `${r.method} ${r.url} deveria estar no escopo protegido`).toBe(true);
      const res = await app.inject({
        method: r.method as "GET",
        url: r.url.replace(":id", "3fce024b-dde7-4aa6-9ef9-fd63be37ff98"),
        payload: r.method === "GET" || r.method === "DELETE" ? undefined : { name: "x" },
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
  });

  it("as rotas públicas listadas existem e não estão marcadas como protegidas", () => {
    for (const key of PUBLIC) {
      const r = app.routeTable.find((x) => `${x.method} ${x.url}` === key);
      expect(r, key).toBeDefined();
      expect(r!.protected).toBe(false);
    }
  });

  it("cookie forjado/aleatório não autentica", async () => {
    for (const name of ["__Host-pulse_session", "pulse_session"]) {
      const res = await app.inject({ method: "GET", url: "/monitors", headers: { cookie: `${name}=forjado` } });
      expect(res.statusCode).toBe(401);
    }
  });

  it("a antiga flag ADMIN_ROUTES_ENABLED não abre nada", async () => {
    const a = buildApp(loadConfig({ ...env, NODE_ENV: "development", ADMIN_ROUTES_ENABLED: "true" }), stubDb);
    expect((await a.inject({ method: "GET", url: "/monitors" })).statusCode).toBe(401);
    expect((await a.inject({ method: "POST", url: "/monitors", payload: {} })).statusCode).toBe(401);
  });

  it("401 não revela nada além do necessário", async () => {
    const res = await app.inject({ method: "GET", url: "/monitors" });
    expect(res.json()).toEqual({ error: "unauthorized", message: "Autenticação necessária", requestId: expect.any(String) });
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("configuração de autenticação", () => {
  it("SameSite=None exige produção e CORS_ALLOWED_ORIGIN", () => {
    expect(() => loadConfig({ ...env, SESSION_COOKIE_SAMESITE: "none", NODE_ENV: "development" })).toThrow(/SAMESITE/);
    expect(() => loadConfig({ ...env, SESSION_COOKIE_SAMESITE: "none", NODE_ENV: "production" })).toThrow(/SAMESITE/);
    expect(
      loadConfig({ ...env, SESSION_COOKIE_SAMESITE: "none", NODE_ENV: "production", CORS_ALLOWED_ORIGIN: "https://app.exemplo.com" })
        .SESSION_COOKIE_SAMESITE,
    ).toBe("none");
  });

  it("padrões seguros: production, SameSite=strict, sem CORS", () => {
    const c = loadConfig(env);
    expect([c.NODE_ENV, c.SESSION_COOKIE_SAMESITE, c.CORS_ALLOWED_ORIGIN]).toEqual(["production", "strict", undefined]);
  });
});
