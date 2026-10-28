import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, csrf } from "../src/api/client";
import { adminApi, authApi, publicApi } from "../src/api/endpoints";

type Call = { url: string; init: RequestInit };
let calls: Call[];
function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => (calls.push({ url, init }), handler(url, init))));
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const headersOf = (c: Call) => c.init.headers as Record<string, string>;

beforeEach(() => csrf.clear());
afterEach(() => vi.unstubAllGlobals());

describe("cliente HTTP: cookies e CSRF conforme o API.md", () => {
  it("rotas públicas não levam cookie (credentials omit) nem token CSRF", async () => {
    mockFetch(() => json(200, { generatedAt: "x", monitors: [] }));
    await publicApi.status();
    expect(calls[0]!.init.credentials).toBe("omit");
    expect(headersOf(calls[0]!)["x-csrf-token"]).toBeUndefined();
    expect(calls[0]!.url).toMatch(/\/public\/status$/);
  });

  it("login guarda o token só em memória e usa credentials include", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    mockFetch(() => json(200, { username: "admin", csrfToken: "tok-123", expiresAt: "2026-10-28T00:00:00Z" }));
    await authApi.login("admin", "senha");
    expect(calls[0]!.init.credentials).toBe("include");
    expect(csrf.get()).toBe("tok-123");
    expect(setItem).not.toHaveBeenCalled(); // nada de localStorage/sessionStorage
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain("tok-123");
    setItem.mockRestore();
  });

  it("GET admin não envia X-CSRF-Token; POST/PATCH/DELETE enviam", async () => {
    csrf.set("tok-abc");
    mockFetch(() => json(200, { monitors: [] }));
    await adminApi.list();
    mockFetch((_u, init) => (init.method === "DELETE" ? new Response(null, { status: 204 }) : json(200, {})));
    await adminApi.create({ name: "a", url: "https://x.example.com", intervalSeconds: 60, publicVisible: true });
    await adminApi.update("id1", { name: "b" });
    await adminApi.pause("id1");
    await adminApi.resume("id1");
    await adminApi.remove("id1");
    expect(calls.map((c) => [c.init.method, headersOf(c)["x-csrf-token"]])).toEqual([
      ["POST", "tok-abc"], ["PATCH", "tok-abc"], ["POST", "tok-abc"], ["POST", "tok-abc"], ["DELETE", "tok-abc"],
    ]);
    expect(calls.every((c) => c.init.credentials === "include")).toBe(true);
  });

  it("pause/resume não enviam corpo; create envia JSON", async () => {
    csrf.set("t");
    mockFetch(() => json(200, {}));
    await adminApi.pause("id1");
    await adminApi.create({ name: "a", url: "https://x.example.com", intervalSeconds: 30, publicVisible: true });
    expect(calls[0]!.init.body).toBeUndefined();
    expect(headersOf(calls[1]!)["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ name: "a", url: "https://x.example.com", intervalSeconds: 30, publicVisible: true });
  });

  it("logout limpa o token da memória só depois do sucesso", async () => {
    csrf.set("t");
    mockFetch(() => new Response(null, { status: 204 }));
    await authApi.logout();
    expect(csrf.get()).toBeNull();
  });

  it("logout que falha mantém o token (a sessão continua válida no servidor)", async () => {
    csrf.set("t");
    mockFetch(() => json(500, { error: "internal_error", message: "Erro interno", requestId: "req-1" }));
    await expect(authApi.logout()).rejects.toBeInstanceOf(ApiError);
    expect(csrf.get()).toBe("t");
  });

  it("query vazia é omitida e o cursor vai na URL", async () => {
    mockFetch(() => json(200, { monitorId: "m", checks: [], nextCursor: null }));
    await publicApi.history("m1", { cursor: "abc", limit: 50 });
    await publicApi.history("m1", {});
    expect(calls[0]!.url).toMatch(/\/public\/monitors\/m1\/history\?cursor=abc&limit=50$/);
    expect(calls[1]!.url).toMatch(/history$/);
  });
});

describe("cliente HTTP: erros do contrato", () => {
  const fail = async (status: number, body: unknown, headers = {}) => {
    mockFetch(() => json(status, body, headers));
    return (await adminApi.list().catch((e) => e)) as ApiError;
  };

  it("400 validation_error traz issues", async () => {
    const e = await fail(400, { error: "validation_error", message: "Dados inválidos", requestId: "req-2", issues: [{ path: "url", message: "Host não permitido" }] });
    expect(e).toMatchObject({ status: 400, code: "validation_error", requestId: "req-2", issues: [{ path: "url", message: "Host não permitido" }] });
  });
  it.each([[401, "unauthorized"], [403, "csrf"], [403, "origin_not_allowed"], [409, "monitor_limit_reached"], [404, "not_found"]])("%i %s", async (status, code) => {
    const e = await fail(status, { error: code, message: "m", requestId: "r" });
    expect(e).toMatchObject({ status, code });
  });
  it("429 lê Retry-After quando o navegador o expõe", async () => {
    const e = await fail(429, { error: "too_many_attempts", message: "m", requestId: "r" }, { "retry-after": "900" });
    expect(e.retryAfterSeconds).toBe(900);
  });
  it("429 sem Retry-After legível não inventa o valor", async () => {
    const e = await fail(429, { error: "too_many_attempts", message: "m", requestId: "r" });
    expect(e.retryAfterSeconds).toBeUndefined();
  });
  it("falha de rede vira ApiError network", async () => {
    mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const e = (await adminApi.list().catch((x) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.network).toBe(true);
    expect(e.code).toBe("network_error");
  });
  it("resposta de erro sem JSON ainda gera um ApiError útil", async () => {
    mockFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const e = (await adminApi.list().catch((x) => x)) as ApiError;
    expect(e).toMatchObject({ status: 502, code: "http_502" });
  });
  it("cancelamento (AbortError) não vira ApiError", async () => {
    mockFetch(() => Promise.reject(new DOMException("aborted", "AbortError")));
    const e = await publicApi.status().catch((x) => x);
    expect((e as DOMException).name).toBe("AbortError");
  });
});
