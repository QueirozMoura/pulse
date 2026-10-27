import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type dns from "node:dns";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpCheck } from "../src/checker/http-check.js";
import { isPublicIp } from "../src/security/ip.js";
import { BlockedTargetError, createGuardedLookup, type Resolver } from "../src/security/guarded-lookup.js";
import { monitorUrlSchema } from "../src/domain/monitor-url.js";

const resolverTo =
  (...addrs: string[]): Resolver =>
  (_h, _o, cb) =>
    cb(null, addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })) as dns.LookupAddress[]);

describe("isPublicIp", () => {
  it.each([
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "127.255.255.254", "169.254.169.254",
    "172.16.0.1", "172.31.255.255", "192.168.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
    "64:ff9b::7f00:1", "2002:7f00:1::", "not-an-ip",
  ])("%s é bloqueado", (ip) => expect(isPublicIp(ip)).toBe(false));

  it.each(["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "100.63.255.255", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "%s é público",
    (ip) => expect(isPublicIp(ip)).toBe(true),
  );
});

describe("monitorUrlSchema: formas ofuscadas de IP interno", () => {
  it.each([
    "https://2130706433/", // 127.0.0.1 em decimal
    "https://0x7f.0.0.1/",
    "https://0177.0.0.1/",
    "https://127.1/",
    "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:7f00:1]/",
    "https://[fd00::1]/",
    "https://localhost./",
    "https://LOCALHOST/",
    "https://a.localhost/",
  ])("rejeita %s", (u) => expect(monitorUrlSchema.safeParse(u).success).toBe(false));
});

describe("createGuardedLookup", () => {
  const lookup = (r: Resolver, all = false) =>
    new Promise<unknown>((resolve) =>
      createGuardedLookup({ resolver: r })("site.test", { all } as never, ((err: unknown, a: unknown, f: unknown) =>
        resolve(err ?? (all ? a : [a, f]))) as never),
    );

  it("nome público → IP público passa", async () => {
    expect(await lookup(resolverTo("93.184.216.34"))).toEqual(["93.184.216.34", 4]);
  });

  it("nome que resolve para IP interno é recusado", async () => {
    expect(await lookup(resolverTo("10.0.0.7"))).toBeInstanceOf(BlockedTargetError);
    expect(await lookup(resolverTo("127.0.0.1"), true)).toBeInstanceOf(BlockedTargetError);
    expect(await lookup(resolverTo("::ffff:192.168.1.1"))).toBeInstanceOf(BlockedTargetError);
  });

  it("um único endereço interno entre vários públicos recusa a resolução inteira", async () => {
    expect(await lookup(resolverTo("93.184.216.34", "169.254.169.254"), true)).toBeInstanceOf(BlockedTargetError);
  });
});

describe("httpCheck: DNS apontando para rede interna (sem overrides)", () => {
  let server: Server;
  let port: number;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.writeHead(200).end("internal secret");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it("nome público que resolve para 127.0.0.1 é bloqueado e o servidor interno nunca recebe requisição", async () => {
    // https + porta do servidor local: se o bloqueio falhasse, haveria conexão (e hit) no servidor interno.
    const out = await httpCheck(`https://parece-publico.test:${port}/`, {
      timeoutMs: 1000,
      resolver: resolverTo("127.0.0.1"),
    });
    expect(out).toMatchObject({ success: false, statusCode: null, errorKind: "blocked" });
    expect(hits).toBe(0);
  });

  it("IP literal interno é bloqueado antes de qualquer DNS", async () => {
    let resolved = false;
    const out = await httpCheck(`https://127.0.0.1:${port}/`, {
      timeoutMs: 1000,
      resolver: ((_h: string, _o: unknown, cb: (e: null, a: unknown[]) => void) => {
        resolved = true;
        cb(null, []);
      }) as never,
    });
    expect(out.errorKind).toBe("blocked");
    expect(resolved).toBe(false);
    expect(hits).toBe(0);
  });

  it("http (sem TLS) é recusado por padrão", async () => {
    const out = await httpCheck(`http://example.com/`, { timeoutMs: 1000, resolver: resolverTo("93.184.216.34") });
    expect(out.errorKind).toBe("blocked");
  });

  it("DNS rebinding: a conexão usa só o resultado validado e cada resolução é revalidada", async () => {
    // 1ª resolução: público. 2ª: interno. Uma checagem sem redirects deve resolver UMA vez
    // (nada a "trocar" entre validar e conectar); a resolução seguinte, já interna, é recusada.
    let calls = 0;
    const flipping: Resolver = (_h, _o, cb) => {
      calls++;
      const address = calls === 1 ? "203.0.114.10" : "127.0.0.1"; // 203.0.114.x é público (fora do bloco de documentação)
      cb(null, [{ address, family: 4 }] as dns.LookupAddress[]);
    };

    // 1ª checagem: o IP público validado (sem ninguém ouvindo) → conexão ao IP validado, falha de rede, nunca 'blocked'.
    const first = await httpCheck(`https://rebind.test:${port}/`, { timeoutMs: 800, resolver: flipping });
    expect(calls).toBe(1);
    expect(first.errorKind).not.toBe("blocked");

    // 2ª checagem: o DNS agora devolve 127.0.0.1 → bloqueado, e o servidor interno segue sem hits.
    const second = await httpCheck(`https://rebind.test:${port}/`, { timeoutMs: 800, resolver: flipping });
    expect(calls).toBe(2);
    expect(second.errorKind).toBe("blocked");
    expect(hits).toBe(0);
  });
});
