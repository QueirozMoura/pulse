import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_PASSWORD, ADMIN_USER, TEST_DB_URL, authed, login, resetDb, seedAdmin, setup, sha256, validBody, type Ctx } from "./helpers.js";
import { resetAdminPassword } from "../src/auth/admin-account.js";

describe.skipIf(!TEST_DB_URL)("autenticação (PostgreSQL real)", () => {
  let c: Ctx;
  beforeAll(async () => void (c = await setup()));
  afterAll(() => c.close());
  beforeEach(async () => {
    await resetDb(c.db);
    await seedAdmin(c.db);
  });

  const post = (url: string, payload: unknown, headers: Record<string, string> = {}, remoteAddress = "10.1.1.1") =>
    c.app.inject({ method: "POST", url, payload: payload as object, headers, remoteAddress });

  describe("login", () => {
    it("credenciais corretas: 200, cookie de sessão e token CSRF; senha nunca volta", async () => {
      const res = await post("/auth/login", { username: ADMIN_USER, password: ADMIN_PASSWORD });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.username).toBe(ADMIN_USER);
      expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(res.body).not.toContain(ADMIN_PASSWORD);
      expect(res.body).not.toContain("scrypt$");
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("cookie: HttpOnly, SameSite=Strict, Path=/ (sem Secure em desenvolvimento)", async () => {
      const l = await login(c.app);
      expect(l.setCookie).toMatch(/^pulse_session=/);
      expect(l.setCookie).toMatch(/HttpOnly/i);
      expect(l.setCookie).toMatch(/SameSite=Strict/i);
      expect(l.setCookie).toMatch(/Path=\//);
      expect(l.setCookie).not.toMatch(/Secure/i);
      expect(l.setCookie).toMatch(/Expires=/i);
    });

    it("em produção o cookie é __Host-, Secure, HttpOnly e SameSite=Strict", async () => {
      const prod = await setup({ NODE_ENV: "production" });
      try {
        const l = await login(prod.app);
        expect(l.setCookie).toMatch(/^__Host-pulse_session=/);
        expect(l.setCookie).toMatch(/; Secure/i);
        expect(l.setCookie).toMatch(/HttpOnly/i);
        expect(l.setCookie).toMatch(/SameSite=Strict/i);
        expect(l.setCookie).not.toMatch(/Domain=/i);
      } finally {
        await prod.close();
      }
    });

    it("senha errada e usuário inexistente dão a MESMA resposta genérica", async () => {
      const wrongPass = await post("/auth/login", { username: ADMIN_USER, password: "senha errada 123456" });
      const wrongUser = await post("/auth/login", { username: "ninguem", password: ADMIN_PASSWORD });
      expect(wrongPass.statusCode).toBe(401);
      expect(wrongUser.statusCode).toBe(401);
      expect(wrongPass.json()).toEqual(wrongUser.json());
      expect(wrongPass.headers["set-cookie"]).toBeUndefined();
    });

    it("usuário não diferencia maiúsculas/minúsculas e espaços", async () => {
      const res = await post("/auth/login", { username: "  ADMIN ", password: ADMIN_PASSWORD });
      expect(res.statusCode).toBe(200);
    });

    it.each([{}, { username: "admin" }, { username: 1, password: 2 }, { username: "a".repeat(65), password: "x" }, { username: "admin", password: "x".repeat(129) }])(
      "entrada inválida %j → 400",
      async (payload) => {
        expect((await post("/auth/login", payload)).statusCode).toBe(400);
      },
    );

    it("login a partir de outra origem (login CSRF) é recusado", async () => {
      const res = await post("/auth/login", { username: ADMIN_USER, password: ADMIN_PASSWORD }, { origin: "https://evil.example" });
      expect(res.statusCode).toBe(403);
      expect(res.headers["set-cookie"]).toBeUndefined();
    });
  });

  describe("limite de tentativas", () => {
    const bad = (ip: string) => post("/auth/login", { username: ADMIN_USER, password: "senha errada 123456" }, {}, ip);

    it("após 5 falhas o IP é bloqueado (429 + Retry-After), inclusive com a senha correta", async () => {
      for (let i = 0; i < 5; i++) expect((await bad("10.2.2.2")).statusCode).toBe(401);
      const blocked = await post("/auth/login", { username: ADMIN_USER, password: ADMIN_PASSWORD }, {}, "10.2.2.2");
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error).toBe("too_many_attempts");
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
      expect(blocked.headers["set-cookie"]).toBeUndefined();
    });

    it("o bloqueio de um IP não afeta outro IP", async () => {
      for (let i = 0; i < 5; i++) await bad("10.3.3.3");
      expect((await post("/auth/login", { username: ADMIN_USER, password: ADMIN_PASSWORD }, {}, "10.4.4.4")).statusCode).toBe(200);
    });

    it("login bem-sucedido zera as falhas daquele IP", async () => {
      for (let i = 0; i < 4; i++) await bad("10.5.5.5");
      expect((await post("/auth/login", { username: ADMIN_USER, password: ADMIN_PASSWORD }, {}, "10.5.5.5")).statusCode).toBe(200);
      for (let i = 0; i < 4; i++) expect((await bad("10.5.5.5")).statusCode).toBe(401);
    });

    it("limite global vale para ataques distribuídos (vários IPs)", async () => {
      const g = await setup({ LOGIN_MAX_FAILURES_GLOBAL: "3", LOGIN_MAX_FAILURES_PER_IP: "100" });
      try {
        for (const ip of ["10.6.0.1", "10.6.0.2", "10.6.0.3"]) {
          await g.app.inject({ method: "POST", url: "/auth/login", payload: { username: ADMIN_USER, password: "senha errada 123456" }, remoteAddress: ip });
        }
        const res = await g.app.inject({ method: "POST", url: "/auth/login", payload: { username: ADMIN_USER, password: ADMIN_PASSWORD }, remoteAddress: "10.6.0.99" });
        expect(res.statusCode).toBe(429);
      } finally {
        await g.close();
      }
    });

    it("as falhas ficam no banco (valem entre instâncias/restarts)", async () => {
      await bad("10.7.7.7");
      expect(await c.db.loginFailure.count({ where: { ip: "10.7.7.7" } })).toBe(1);
    });
  });

  describe("sessão", () => {
    it("GET /auth/session com cookie válido devolve o usuário e o token CSRF", async () => {
      const l = await login(c.app);
      const res = await c.app.inject({ method: "GET", url: "/auth/session", headers: { cookie: l.cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ username: ADMIN_USER, csrfToken: l.csrf });
    });

    it("o banco guarda só o hash do token, nunca o token do cookie", async () => {
      const l = await login(c.app);
      const rows = await c.db.session.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(sha256(l.token));
      expect(rows[0]!.id).not.toBe(l.token);
    });

    it("sessão expirada é recusada e removida", async () => {
      const l = await login(c.app);
      await c.db.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await c.app.inject({ method: "GET", url: "/monitors", headers: { cookie: l.cookie } });
      expect(res.statusCode).toBe(401);
      expect(await c.db.session.count()).toBe(0);
    });

    it("logout invalida a sessão no servidor (reusar o cookie falha) e limpa o cookie", async () => {
      const l = await login(c.app);
      const out = await c.app.inject({ method: "POST", url: "/auth/logout", headers: authed(l) });
      expect(out.statusCode).toBe(204);
      expect(String(out.headers["set-cookie"])).toMatch(/pulse_session=;/);
      const again = await c.app.inject({ method: "GET", url: "/monitors", headers: { cookie: l.cookie } });
      expect(again.statusCode).toBe(401);
    });

    it("logout exige CSRF", async () => {
      const l = await login(c.app);
      const res = await c.app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: l.cookie } });
      expect(res.statusCode).toBe(403);
      expect(await c.db.session.count()).toBe(1);
    });

    it("sessões são independentes e cada login gera token novo", async () => {
      const a = await login(c.app);
      const b = await login(c.app);
      expect(a.token).not.toBe(b.token);
      expect(a.csrf).not.toBe(b.csrf);
    });

    it("redefinir a senha encerra todas as sessões e a senha antiga deixa de valer", async () => {
      const l = await login(c.app);
      await resetAdminPassword(c.db, "nova senha bem comprida 99");
      expect((await c.app.inject({ method: "GET", url: "/monitors", headers: { cookie: l.cookie } })).statusCode).toBe(401);
      expect((await post("/auth/login", { username: ADMIN_USER, password: ADMIN_PASSWORD })).statusCode).toBe(401);
      expect((await post("/auth/login", { username: ADMIN_USER, password: "nova senha bem comprida 99" })).statusCode).toBe(200);
    });
  });

  describe("CSRF nas operações administrativas", () => {
    it("sem token CSRF → 403 e nada é criado", async () => {
      const l = await login(c.app);
      const res = await post("/monitors", validBody, { cookie: l.cookie });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("csrf");
      expect(await c.db.monitor.count()).toBe(0);
    });

    it("token CSRF errado (ou de outra sessão) → 403", async () => {
      const l = await login(c.app);
      const other = await login(c.app);
      expect((await post("/monitors", validBody, { cookie: l.cookie, "x-csrf-token": "errado" })).statusCode).toBe(403);
      expect((await post("/monitors", validBody, { cookie: l.cookie, "x-csrf-token": other.csrf })).statusCode).toBe(403);
    });

    it("Origin de outro site → 403 mesmo com token válido", async () => {
      const l = await login(c.app);
      const res = await post("/monitors", validBody, authed(l, { origin: "https://evil.example" }));
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("origin_not_allowed");
    });

    it("PATCH e DELETE também exigem CSRF", async () => {
      const l = await login(c.app);
      const created = (await post("/monitors", validBody, authed(l))).json();
      const patch = await c.app.inject({ method: "PATCH", url: `/monitors/${created.id}`, payload: { name: "x" }, headers: { cookie: l.cookie } });
      const del = await c.app.inject({ method: "DELETE", url: `/monitors/${created.id}`, headers: { cookie: l.cookie } });
      expect([patch.statusCode, del.statusCode]).toEqual([403, 403]);
      expect(await c.db.monitor.count()).toBe(1);
    });

    it("leituras (GET) não exigem token CSRF, só sessão", async () => {
      const l = await login(c.app);
      expect((await c.app.inject({ method: "GET", url: "/monitors", headers: { cookie: l.cookie } })).statusCode).toBe(200);
    });

    it("com CORS_ALLOWED_ORIGIN, o frontend configurado é aceito e outro não", async () => {
      const x = await setup({ CORS_ALLOWED_ORIGIN: "https://app.exemplo.com" });
      try {
        const l = await login(x.app);
        const ok = await x.app.inject({ method: "POST", url: "/monitors", payload: validBody, headers: authed(l, { origin: "https://app.exemplo.com" }) });
        const bad = await x.app.inject({ method: "POST", url: "/monitors", payload: validBody, headers: authed(l, { origin: "https://app.evil.com" }) });
        expect([ok.statusCode, bad.statusCode]).toEqual([201, 403]);

        const pre = await x.app.inject({ method: "OPTIONS", url: "/monitors", headers: { origin: "https://app.exemplo.com", "access-control-request-method": "POST" } });
        expect(pre.headers["access-control-allow-origin"]).toBe("https://app.exemplo.com");
        expect(pre.headers["access-control-allow-credentials"]).toBe("true");
        const evil = await x.app.inject({ method: "OPTIONS", url: "/monitors", headers: { origin: "https://evil.com", "access-control-request-method": "POST" } });
        // O plugin devolve sempre a origem configurada; o navegador bloqueia quando difere da origem da página.
        expect(evil.headers["access-control-allow-origin"]).not.toBe("https://evil.com");
        expect(evil.headers["access-control-allow-origin"]).not.toBe("*");
      } finally {
        await x.close();
      }
    });
  });
});
