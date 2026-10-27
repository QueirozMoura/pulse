import type { InjectOptions } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Db } from "../src/lib/db.js";

const env = { DATABASE_URL: "postgresql://x@localhost/x", LOG_LEVEL: "silent", NODE_ENV: "production" };

// Um banco que falha com uma mensagem cheia de segredos, para provar que ela nunca chega ao cliente.
const LEAKY = "password=hunter2 host=10.0.0.5 connect ECONNREFUSED postgresql://pulse:s3cr3t@db.internal/pulse";
const boom = async () => {
  throw new Error(LEAKY);
};
const brokenDb = {
  monitor: { findMany: boom, findUnique: boom, count: boom },
  incident: { findMany: boom },
  checkResult: { findMany: boom, groupBy: boom },
  adminUser: { findUnique: boom },
  loginFailure: { deleteMany: boom, count: boom },
  session: { findUnique: async () => null },
  $queryRaw: boom,
} as unknown as Db;

describe("formato único de erro", () => {
  const app = buildApp(loadConfig(env), brokenDb, { schedulerStatus: () => "ok" });
  const big = JSON.stringify({ username: "a", password: "x".repeat(20_000) });

  const cases: { name: string; req: InjectOptions; status: number; code: string }[] = [
    { name: "rota inexistente", req: { method: "GET", url: "/nada" }, status: 404, code: "not_found" },
    { name: "método não suportado na rota", req: { method: "PUT", url: "/public/status" }, status: 404, code: "not_found" },
    { name: "sem sessão", req: { method: "GET", url: "/monitors" }, status: 401, code: "unauthorized" },
    { name: "validação de query", req: { method: "GET", url: "/public/incidents?limit=999" }, status: 400, code: "validation_error" },
    { name: "id inválido", req: { method: "GET", url: "/public/monitors/abc" }, status: 400, code: "validation_error" },
    { name: "JSON malformado", req: { method: "POST", url: "/auth/login", headers: { "content-type": "application/json" }, payload: "{nope" }, status: 400, code: "bad_request" },
    { name: "corpo ausente no login", req: { method: "POST", url: "/auth/login" }, status: 400, code: "validation_error" },
    { name: "Content-Type não suportado", req: { method: "POST", url: "/auth/login", headers: { "content-type": "text/plain" }, payload: "oi" }, status: 415, code: "unsupported_media_type" },
    { name: "corpo grande demais", req: { method: "POST", url: "/auth/login", headers: { "content-type": "application/json" }, payload: big }, status: 413, code: "payload_too_large" },
    { name: "falha interna (banco) em rota pública", req: { method: "GET", url: "/public/status" }, status: 500, code: "internal_error" },
    { name: "falha interna no histórico", req: { method: "GET", url: "/public/monitors/3fce024b-dde7-4aa6-9ef9-fd63be37ff98/history" }, status: 500, code: "internal_error" },
    { name: "falha interna no login", req: { method: "POST", url: "/auth/login", payload: { username: "a", password: "b" } }, status: 500, code: "internal_error" },
  ];

  it.each(cases)("$name → $status $code", async ({ req, status, code }) => {
    const res = await app.inject(req);
    expect(res.statusCode).toBe(status);
    const body = res.json();
    expect(Object.keys(body).filter((k) => !["error", "message", "requestId", "issues"].includes(k))).toEqual([]);
    expect(body.error).toBe(code);
    expect(body.message).toEqual(expect.any(String));
    expect(body.requestId).toEqual(expect.any(String));
    expect(res.headers["x-request-id"]).toBe(body.requestId);
  });

  it("nenhuma resposta de erro vaza segredos, hosts, stack ou a mensagem original", async () => {
    for (const { req } of cases) {
      const text = (await app.inject(req)).body;
      expect(text).not.toMatch(/hunter2|s3cr3t|10\.0\.0\.5|ECONNREFUSED|db\.internal|postgresql:|\bat \S+\.(ts|js):\d+/);
    }
  });

  it("/health com banco fora devolve 503 sem detalhes; scheduler travado também", async () => {
    const down = await app.inject({ method: "GET", url: "/health" });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ status: "degraded", scheduler: "ok" });

    const okDb = { $queryRaw: async () => [{ "?column?": 1 }] } as unknown as Db;
    const stalled = buildApp(loadConfig(env), okDb, { schedulerStatus: () => "stalled" });
    const res = await stalled.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "degraded", scheduler: "stalled" });

    const healthy = buildApp(loadConfig(env), okDb);
    expect((await healthy.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok", scheduler: "disabled" });
  });

  it("422 de validação lista campos e mensagens, e só isso", async () => {
    const res = await app.inject({ method: "GET", url: "/public/incidents?limit=999&status=x" });
    expect(res.json().issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: "limit", message: expect.any(String) })]));
    for (const i of res.json().issues) expect(Object.keys(i).sort()).toEqual(["message", "path"]);
  });
});
