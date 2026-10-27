import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyError, httpCheck } from "../src/checker/http-check.js";

// Servidor HTTP local simulado. Como ele é http/127.0.0.1, os testes relaxam
// explicitamente as proteções (o caminho de produção é testado em ssrf.test.ts).
const LOCAL = { allowHttp: true, trustedHosts: ["127.0.0.1"] };

let server: Server;
let base: string;
let hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    hits.push(url);
    const redirect = (to: string, code = 302) => void res.writeHead(code, { location: to }).end();
    if (url === "/ok") return void res.writeHead(200).end("ok");
    if (url === "/error") return void res.writeHead(503).end("secret internal stack trace");
    if (url === "/slow") return void setTimeout(() => res.writeHead(200).end("late"), 2000);
    // cadeias de redirect
    if (url === "/r-ok") return redirect("/ok", 301);
    if (url === "/r-chain") return redirect("/r-ok");
    if (url === "/r-to-error") return redirect("/error", 301);
    if (url === "/r-to-404") return redirect("/missing", 308);
    if (url === "/loop-a") return redirect("/loop-b");
    if (url === "/loop-b") return redirect("/loop-a");
    if (url === "/no-location") return void res.writeHead(302).end();
    if (url === "/bad-location") return void res.writeHead(302, { location: "http://[::bad" }).end();
    if (url.startsWith("/n/")) return redirect(`/n/${Number(url.slice(3)) + 1}`); // infinito
    if (url === "/to-metadata") return redirect("http://169.254.169.254/latest/meta-data");
    if (url === "/to-file") return redirect("file:///etc/passwd");
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const check = (path: string, extra: object = {}) =>
  httpCheck(`${base}${path}`, { timeoutMs: 1500, unsafeTestOverrides: LOCAL, ...extra });

describe("httpCheck: resposta direta", () => {
  it("200 é sucesso e mede a latência", async () => {
    const out = await check("/ok");
    expect(out).toMatchObject({ success: true, statusCode: 200, errorKind: null });
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("5xx é falha http_status", async () => {
    expect(await check("/error")).toMatchObject({ success: false, statusCode: 503, errorKind: "http_status" });
  });

  it("resposta mais lenta que o timeout é 'timeout' sem status", async () => {
    const out = await check("/slow", { timeoutMs: 200 });
    expect(out).toMatchObject({ success: false, statusCode: null, errorKind: "timeout" });
    expect(out.latencyMs).toBeLessThan(1500);
  });

  it("conexão recusada vira 'connection' e não vaza a mensagem do erro", async () => {
    const tmp = createServer();
    await new Promise<void>((r) => tmp.listen(0, "127.0.0.1", r));
    const closedPort = (tmp.address() as AddressInfo).port;
    await new Promise((r) => tmp.close(r));
    const out = await httpCheck(`http://127.0.0.1:${closedPort}/`, { timeoutMs: 1000, unsafeTestOverrides: LOCAL });
    expect(out).toMatchObject({ success: false, statusCode: null, errorKind: "connection" });
    expect(JSON.stringify(out)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
  });

  it("DNS que falha vira 'dns'", async () => {
    const resolver = (_h: string, _o: unknown, cb: (e: NodeJS.ErrnoException) => void) =>
      cb(Object.assign(new Error("x"), { code: "ENOTFOUND" }));
    const out = await httpCheck("https://exemplo.test", { timeoutMs: 1000, resolver: resolver as never });
    expect(out).toMatchObject({ success: false, errorKind: "dns" });
  });
});

describe("httpCheck: redirects", () => {
  it("301 que leva a 200 é sucesso, avaliado pela resposta FINAL", async () => {
    expect(await check("/r-ok")).toMatchObject({ success: true, statusCode: 200 });
  });

  it("segue cadeias de redirects", async () => {
    expect(await check("/r-chain")).toMatchObject({ success: true, statusCode: 200 });
  });

  it("301 cujo destino final retorna 5xx é FALHA (301 isolado não prova nada)", async () => {
    expect(await check("/r-to-error")).toMatchObject({ success: false, statusCode: 503, errorKind: "http_status" });
  });

  it("redirect para destino 404 é falha", async () => {
    expect(await check("/r-to-404")).toMatchObject({ success: false, statusCode: 404 });
  });

  it("respeita o limite de redirects", async () => {
    hits = [];
    const out = await check("/n/0", { maxRedirects: 3 });
    expect(out).toMatchObject({ success: false, statusCode: null, errorKind: "redirect" });
    expect(hits).toHaveLength(4); // requisição inicial + 3 redirects, e para
  });

  it("detecta loops", async () => {
    expect(await check("/loop-a")).toMatchObject({ success: false, errorKind: "redirect" });
  });

  it.each(["/no-location", "/bad-location"])("redirect inválido %s é falha", async (p) => {
    expect(await check(p)).toMatchObject({ success: false, errorKind: "redirect" });
  });

  it("redirect para IP interno (metadados de nuvem) é bloqueado: o 1º hop é confiável, o destino não", async () => {
    hits = [];
    const out = await check("/to-metadata");
    expect(out).toMatchObject({ success: false, errorKind: "blocked" });
    expect(hits).toEqual(["/to-metadata"]); // seguiu até o redirect e parou nele
  });

  it("redirect para outro protocolo (file:) é bloqueado", async () => {
    expect(await check("/to-file")).toMatchObject({ success: false, errorKind: "blocked" });
  });
});

describe("classifyError", () => {
  it("erros desconhecidos viram 'unknown'", () => {
    expect(classifyError(new Error("boom"))).toBe("unknown");
    expect(classifyError("string")).toBe("unknown");
  });

  it("detecta erros de TLS", () => {
    expect(classifyError(Object.assign(new Error("x"), { code: "CERT_HAS_EXPIRED" }))).toBe("tls");
  });
});
