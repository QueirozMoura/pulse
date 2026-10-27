import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatDuration, renderAlert, type AlertContent } from "../src/alerts/email.js";
import { runTestSend } from "../src/alerts/test-send.js";
import { createResendTransport, RESEND_API_URL, type EmailMessage } from "../src/alerts/transports.js";
import { loadConfig } from "../src/config.js";

const T0 = new Date("2026-10-27T01:55:07.540Z");
const opened: AlertContent = { kind: "OPENED", monitorName: "API de pagamentos", startedAt: T0, resolvedAt: null, errorKind: "dns" };
const resolved: AlertContent = { ...opened, kind: "RESOLVED", resolvedAt: new Date(T0.getTime() + 750_000) };

describe("conteúdo do e-mail", () => {
  it("abertura: nome, início e categoria da falha; avisa que não haverá novos alertas", () => {
    const e = renderAlert(opened);
    expect(e.subject).toBe("[Pulse] ALERTA: API de pagamentos está indisponível");
    expect(e.text).toContain('O monitor "API de pagamentos" está INDISPONÍVEL.');
    expect(e.text).toContain("Início do incidente: 2026-10-27 01:55:07 UTC");
    expect(e.text).toContain("falha de resolução de DNS");
    expect(e.text).toContain("Nenhum novo alerta será enviado enquanto o incidente continuar aberto");
  });

  it("resolução: inclui a duração do incidente (12 min 30 s) no assunto e no corpo", () => {
    const e = renderAlert(resolved);
    expect(e.subject).toBe("[Pulse] Resolvido: API de pagamentos voltou ao normal (indisponível por 12 min 30 s)");
    expect(e.text).toContain("Duração: 12 min 30 s");
    expect(e.text).toContain("Fim do incidente: 2026-10-27 02:07:37 UTC");
  });

  it.each([
    [0, "0 s"], [45, "45 s"], [60, "1 min"], [750, "12 min 30 s"], [3600, "1 h"], [3725, "1 h 2 min"], [90_061, "1 d 1 h 1 min"],
  ])("formatDuration(%i) = %s", (s, out) => expect(formatDuration(s)).toBe(out));

  it("nome malicioso: HTML escapado e sem quebras de linha no assunto", () => {
    const e = renderAlert({ ...opened, monitorName: 'Loja <script>alert(1)</script>\r\nBcc: atacante@x.com' });
    expect(e.html).not.toContain("<script>");
    expect(e.html).toContain("&lt;script&gt;");
    expect(e.subject).not.toMatch(/[\r\n]/);
  });

  it("categoria desconhecida cai num texto genérico; sem categoria, a linha some", () => {
    expect(renderAlert({ ...opened, errorKind: "algo-novo" }).text).toContain("falha não classificada");
    expect(renderAlert({ ...opened, errorKind: null }).text).not.toContain("Tipo da falha");
  });

  it("o conteúdo só pode conter o que o tipo permite: URL, host, token, cookie e stack não têm por onde entrar", () => {
    // Mesmo que o chamador tente passar campos extras (ex.: um objeto Monitor inteiro), eles são ignorados.
    const sneaky = {
      ...opened,
      url: "https://segredo-interno.example.net/admin?token=SUPERSECRETO",
      cookie: "pulse_session=abc123",
      stack: "Error: boom\n    at x (/app/src/y.ts:1:1)",
    } as AlertContent;
    for (const e of [renderAlert(sneaky), renderAlert({ ...sneaky, kind: "RESOLVED", resolvedAt: new Date(T0.getTime() + 60_000) })]) {
      const all = `${e.subject}\n${e.text}\n${e.html}`;
      expect(all).not.toMatch(/segredo-interno|SUPERSECRETO|token|pulse_session|abc123|https?:\/\/|\bat \S+\.ts:\d+|boom/i);
    }
  });
});

describe("configuração dos alertas", () => {
  const base = { DATABASE_URL: "postgresql://x@localhost/x" };
  it("padrão: desligado, inclusive sem NENHUMA credencial", () => {
    const c = loadConfig(base);
    expect([c.ALERT_DELIVERY, c.ALERT_EMAIL_TO, c.RESEND_API_KEY, c.ALERT_MAX_PER_HOUR]).toEqual(["off", undefined, undefined, 30]);
  });
  it("modo log não exige credenciais (desenvolvimento)", () => {
    expect(loadConfig({ ...base, NODE_ENV: "development", ALERT_DELIVERY: "log" }).ALERT_DELIVERY).toBe("log");
  });
  it("modo email exige destino, remetente e chave", () => {
    expect(() => loadConfig({ ...base, ALERT_DELIVERY: "email" })).toThrow(/ALERT_EMAIL_TO, ALERT_EMAIL_FROM, RESEND_API_KEY/);
    expect(() => loadConfig({ ...base, ALERT_DELIVERY: "email", ALERT_EMAIL_TO: "eu@exemplo.com", ALERT_EMAIL_FROM: "Pulse <a@exemplo.com>" })).toThrow(/RESEND_API_KEY/);
    const c = loadConfig({ ...base, ALERT_DELIVERY: "email", ALERT_EMAIL_TO: "eu@exemplo.com", ALERT_EMAIL_FROM: "Pulse <alertas@exemplo.com>", RESEND_API_KEY: "re_abcdefghij" });
    expect(c.ALERT_EMAIL_TO).toBe("eu@exemplo.com");
  });
  it.each(["não-é-email", "a@b", "x@y.com\r\nBcc: z@w.com", "um@x.com, dois@y.com"])("destino/remetente inválido %j é recusado", (bad) => {
    const ok = { ...base, ALERT_DELIVERY: "email", RESEND_API_KEY: "re_abcdefghij" };
    expect(() => loadConfig({ ...ok, ALERT_EMAIL_TO: bad, ALERT_EMAIL_FROM: "a@exemplo.com" })).toThrow();
    expect(() => loadConfig({ ...ok, ALERT_EMAIL_TO: "eu@exemplo.com", ALERT_EMAIL_FROM: bad })).toThrow();
  });
});

describe("transporte Resend (servidor HTTP local, nenhuma rede externa)", () => {
  let server: Server;
  let url: string;
  let seen: { method?: string; url?: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  let respond: (n: number) => { status: number; body?: string; delayMs?: number } = () => ({ status: 200, body: '{"id":"msg_123"}' });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        const r = respond(seen.length);
        setTimeout(() => res.writeHead(r.status, { "content-type": "application/json" }).end(r.body ?? ""), r.delayMs ?? 0);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/emails`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  const msg: EmailMessage = { to: "eu@exemplo.com", from: "Pulse <a@exemplo.com>", subject: "assunto", text: "texto", html: "<p>html</p>", idempotencyKey: "pulse-alert-123" };
  const tx = (o = {}) => createResendTransport("re_chave_secreta_123", { url, ...o });

  it("o endereço padrão é o da API do Resend (a suíte não usa o padrão)", () => {
    expect(RESEND_API_URL).toBe("https://api.resend.com/emails");
  });

  it("faz POST com Bearer, Idempotency-Key e o corpo esperado; devolve o id", async () => {
    seen = [];
    respond = () => ({ status: 200, body: '{"id":"msg_123"}' });
    expect(await tx().send(msg)).toEqual({ ok: true, messageId: "msg_123" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers.authorization).toBe("Bearer re_chave_secreta_123");
    expect(seen[0]!.headers["idempotency-key"]).toBe("pulse-alert-123");
    expect(JSON.parse(seen[0]!.body)).toEqual({ from: msg.from, to: [msg.to], subject: "assunto", text: "texto", html: "<p>html</p>" });
  });

  it.each([
    [429, "rate_limited"], [401, "unauthorized"], [403, "unauthorized"], [422, "rejected"], [400, "rejected"], [500, "server_error"], [503, "server_error"],
  ])("HTTP %i vira a categoria %s, sem repassar o corpo do provedor", async (status, kind) => {
    respond = () => ({ status, body: '{"message":"segredo do provedor: re_chave_secreta_123 eu@exemplo.com"}' });
    const r = await tx().send(msg);
    expect(r).toEqual({ ok: false, kind, httpStatus: status });
    expect(JSON.stringify(r)).not.toMatch(/segredo|re_chave|exemplo\.com/);
  });

  it("2xx sem JSON ainda conta como aceito", async () => {
    respond = () => ({ status: 202, body: "" });
    expect(await tx().send(msg)).toEqual({ ok: true, messageId: null });
  });

  it("resposta mais lenta que o timeout → timeout", async () => {
    respond = () => ({ status: 200, body: "{}", delayMs: 500 });
    expect(await tx({ timeoutMs: 100 }).send(msg)).toEqual({ ok: false, kind: "timeout" });
  });

  it("conexão recusada → network (sem vazar a mensagem do erro)", async () => {
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise((r) => dead.close(r));
    const r = await createResendTransport("re_x_123456789", { url: `http://127.0.0.1:${port}/emails` }).send(msg);
    expect(r).toEqual({ ok: false, kind: "network" });
  });
});

describe("test-send (envio de teste controlado)", () => {
  const fake = () => {
    const calls: EmailMessage[] = [];
    return { calls, transport: { send: async (m: EmailMessage) => (calls.push(m), { ok: true as const, messageId: "msg_test" }) } };
  };

  it("sem --confirm NÃO envia: só descreve o que faria", async () => {
    const { calls, transport } = fake();
    const out: string[] = [];
    expect(await runTestSend({ transport, to: "eu@exemplo.com", from: "a@exemplo.com", confirm: false, print: (l) => out.push(l) })).toBe("dry-run");
    expect(calls).toHaveLength(0);
    expect(out.join("\n")).toContain("Nada foi enviado");
  });

  it("com --confirm envia exatamente UM e-mail, claramente marcado como teste", async () => {
    const { calls, transport } = fake();
    expect(await runTestSend({ transport, to: "eu@exemplo.com", from: "a@exemplo.com", confirm: true, print: () => undefined })).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.subject).toContain("TESTE");
    expect(calls[0]!.subject).not.toContain("ALERTA");
    expect(calls[0]!.idempotencyKey).toMatch(/^pulse-test-/);
  });

  it("falha do provedor é reportada como 'failed'", async () => {
    const transport = { send: async () => ({ ok: false as const, kind: "unauthorized" as const, httpStatus: 401 }) };
    const out: string[] = [];
    expect(await runTestSend({ transport, to: "a@b.co", from: "a@b.co", confirm: true, print: (l) => out.push(l) })).toBe("failed");
    expect(out.join("\n")).toContain("unauthorized (HTTP 401)");
  });
});
