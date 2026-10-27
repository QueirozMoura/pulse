import type { FastifyBaseLogger } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AlertDispatcher, type DispatcherOptions } from "../src/alerts/dispatcher.js";
import { createLogTransport, type EmailMessage, type EmailTransport, type SendResult } from "../src/alerts/transports.js";
import type { Db } from "../src/lib/db.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { recordCheck } from "../src/services/check-recorder.js";
import { TEST_DB_URL, down, mkMonitors, ok, resetDb, setup, sleep, waitFor, type Ctx } from "./helpers.js";

const SECRET_URL = "https://segredo-interno.example.net/admin?token=SUPERSECRETO";
const t = (ms: number) => new Date(Date.UTC(2026, 9, 27, 12, 0, 0) + ms);

/** Provedor falso. Imita a idempotência do Resend: a mesma chave não entrega duas vezes. */
function fakeProvider(behavior?: (m: EmailMessage, call: number) => SendResult | Promise<SendResult>) {
  const calls: EmailMessage[] = [];
  const delivered = new Set<string>();
  const transport: EmailTransport = {
    async send(m) {
      calls.push(m);
      const r = behavior ? await behavior(m, calls.length) : ({ ok: true, messageId: `msg_${calls.length}` } as const);
      if (r.ok) delivered.add(m.idempotencyKey);
      return r;
    },
  };
  return { calls, delivered, transport };
}

describe.skipIf(!TEST_DB_URL)("alertas por e-mail (PostgreSQL real, provedor falso)", () => {
  let c: Ctx;
  beforeAll(async () => void (c = await setup()));
  afterAll(() => c.close());
  beforeEach(() => resetDb(c.db));

  const mkDispatcher = (transport: EmailTransport, over: Partial<DispatcherOptions> = {}, db: Db = c.db) =>
    new AlertDispatcher(db, c.app.log, {
      transport,
      to: "admin@exemplo.com",
      from: "Pulse <alertas@exemplo.com>",
      tickMs: 3_600_000,
      backoffSeconds: [0.05],
      leaseMs: 5000,
      ...over,
    });
  const events = () => c.db.alertEvent.findMany({ orderBy: [{ createdAt: "asc" }, { kind: "asc" }] });
  const pump = async (d: AlertDispatcher) => (await d.tick(), await d.idle());

  /** Monitor com incidente e eventos criados diretamente (para cenários de entrega/concorrência). */
  async function seedEvents(n: number, kinds: ("OPENED" | "RESOLVED")[] = ["OPENED"]) {
    const monitors = await mkMonitors(c.db, n, { nextCheckAt: new Date(Date.now() + 3_600_000), prefix: "seed" });
    for (const m of monitors) {
      const inc = await c.db.incident.create({
        data: { monitorId: m.id, startedAt: t(0), resolvedAt: kinds.includes("RESOLVED") ? t(90_000) : null },
      });
      await c.db.alertEvent.createMany({ data: kinds.map((kind) => ({ incidentId: inc.id, kind })) });
    }
    return monitors;
  }

  describe("criação do evento (outbox)", () => {
    let id: string;
    let url: string;
    beforeEach(async () => {
      const [m] = await mkMonitors(c.db, 1);
      id = m!.id;
      url = m!.url;
    });
    const rec = (o: typeof ok | typeof down, ms: number, alerts = true) => recordCheck(c.db, id, o, { url, startedAt: t(ms), alerts });

    it("uma falha isolada não gera evento; a 2ª falha consecutiva gera exatamente UM 'aberto'", async () => {
      await rec(down, 0);
      expect(await events()).toHaveLength(0);
      await rec(down, 1000);
      const ev = await events();
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ kind: "OPENED", status: "PENDING", attempts: 0 });
    });

    it("enquanto continua indisponível, NÃO gera novos eventos (um e-mail por incidente, não por checagem)", async () => {
      for (let i = 0; i < 30; i++) await rec(down, i * 1000);
      expect(await c.db.incident.count()).toBe(1);
      expect(await events()).toHaveLength(1);
    });

    it("a recuperação gera exatamente UM 'resolvido', ligado ao mesmo incidente", async () => {
      await rec(down, 0);
      await rec(down, 1000);
      await rec(ok, 91_000);
      await rec(ok, 92_000);
      const ev = await events();
      expect(ev.map((e) => e.kind).sort()).toEqual(["OPENED", "RESOLVED"]);
      expect(new Set(ev.map((e) => e.incidentId)).size).toBe(1);
    });

    it("sem alertas habilitados nenhum evento é criado", async () => {
      await rec(down, 0, false);
      await rec(down, 1000, false);
      await rec(ok, 2000, false);
      expect(await c.db.incident.count()).toBe(1);
      expect(await events()).toHaveLength(0);
    });

    it("resultado atrasado/obsoleto não cria evento", async () => {
      await rec(down, 0);
      await rec(down, 1000);
      await rec(ok, 5000);
      await rec(down, 2000); // chega tarde: não reabre nada
      await rec(down, 3000);
      expect(await events()).toHaveLength(2);
    });

    it("oscilação gera um par de eventos por incidente", async () => {
      for (const [o, ms] of [[down, 0], [down, 1000], [ok, 2000], [down, 3000], [down, 4000], [ok, 5000]] as const) await rec(o, ms);
      expect(await c.db.incident.count()).toBe(2);
      expect(await events()).toHaveLength(4);
    });

    it("o evento nasce na MESMA transação do incidente: se não puder ser gravado, nada é gravado", async () => {
      await rec(down, 0);
      await c.db.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION pulse_test_fail_alert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'falha simulada'; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER pulse_test_fail_alert_trg BEFORE INSERT ON alert_events FOR EACH ROW EXECUTE FUNCTION pulse_test_fail_alert();`);
      try {
        await expect(rec(down, 1000)).rejects.toThrow();
        expect(await c.db.incident.count()).toBe(0); // sem incidente órfão de alerta
        expect((await c.db.monitor.findUniqueOrThrow({ where: { id } })).consecutiveFailures).toBe(1);
      } finally {
        await c.db.$executeRawUnsafe("DROP TRIGGER pulse_test_fail_alert_trg ON alert_events; DROP FUNCTION pulse_test_fail_alert();");
      }
      await rec(down, 2000); // a próxima checagem refaz a transição normalmente
      expect(await c.db.incident.count()).toBe(1);
      expect(await events()).toHaveLength(1);
    });

    it("duas gravações concorrentes da mesma transição nunca duplicam o evento (UNIQUE incidente+tipo)", async () => {
      await rec(down, 0);
      await Promise.all(Array.from({ length: 8 }, (_, i) => rec(down, 1000 + i)));
      const opened = (await events()).filter((e) => e.kind === "OPENED");
      expect(opened.length).toBeLessThanOrEqual(1);
      await expect(
        c.db.alertEvent.create({ data: { incidentId: (await c.db.incident.findFirstOrThrow()).id, kind: "OPENED" } }),
      ).rejects.toMatchObject({ code: "P2002" });
    });
  });

  describe("entrega", () => {
    it("envia o alerta de abertura uma vez e registra o resultado", async () => {
      await seedEvents(1);
      const p = fakeProvider();
      await pump(mkDispatcher(p.transport));
      expect(p.calls).toHaveLength(1);
      const m = p.calls[0]!;
      expect([m.to, m.from]).toEqual(["admin@exemplo.com", "Pulse <alertas@exemplo.com>"]);
      expect(m.subject).toBe("[Pulse] ALERTA: seed0 está indisponível");
      const [e] = await events();
      expect(m.idempotencyKey).toBe(`pulse-alert-${e!.id}`);
      expect(e).toMatchObject({ status: "SENT", attempts: 1, providerMessageId: "msg_1", lastErrorKind: null, lockedUntil: null });
      expect(e!.sentAt).toBeInstanceOf(Date);
    });

    it("enviado não é reenviado em ciclos seguintes", async () => {
      await seedEvents(1);
      const p = fakeProvider();
      const d = mkDispatcher(p.transport);
      await pump(d);
      await pump(d);
      await pump(d);
      expect(p.calls).toHaveLength(1);
    });

    it("o 'resolvido' traz a duração e só sai depois do 'aberto' do mesmo incidente", async () => {
      await seedEvents(1, ["OPENED", "RESOLVED"]);
      const p = fakeProvider((_m, n) => (n === 1 ? { ok: false, kind: "server_error", httpStatus: 503 } : { ok: true, messageId: `msg_${n}` }));
      const d = mkDispatcher(p.transport);

      await pump(d); // 'aberto' falha; 'resolvido' NÃO pode passar à frente
      expect(p.calls.map((m) => m.subject.startsWith("[Pulse] ALERTA"))).toEqual([true]);

      await sleep(80);
      await pump(d); // 'aberto' enfim sai
      await pump(d); // agora o 'resolvido' está liberado
      expect(p.calls.map((m) => m.subject.split(":")[0])).toEqual(["[Pulse] ALERTA", "[Pulse] ALERTA", "[Pulse] Resolvido"]);
      const resolved = p.calls[2]!;
      expect(resolved.subject).toBe("[Pulse] Resolvido: seed0 voltou ao normal (indisponível por 1 min 30 s)");
      expect(resolved.text).toContain("Duração: 1 min 30 s");
      expect((await events()).every((e) => e.status === "SENT")).toBe(true);
    });

    it("se o 'aberto' esgotou as tentativas, o 'resolvido' ainda sai", async () => {
      await seedEvents(1, ["OPENED", "RESOLVED"]);
      const p = fakeProvider((m) => (m.subject.includes("ALERTA") ? { ok: false, kind: "rejected", httpStatus: 422 } : { ok: true, messageId: "msg_r" }));
      const d = mkDispatcher(p.transport, { maxAttempts: 2 });
      for (let i = 0; i < 6; i++) (await pump(d), await sleep(60));
      const ev = Object.fromEntries((await events()).map((e) => [e.kind, e.status]));
      expect(ev).toEqual({ OPENED: "FAILED", RESOLVED: "SENT" });
    });

    it("o e-mail não contém URL, host, token, cookie nem stack (cadeia completa: monitor → incidente → e-mail)", async () => {
      const [m] = await mkMonitors(c.db, 1);
      await c.db.monitor.update({ where: { id: m!.id }, data: { url: SECRET_URL, name: "Painel" } });
      const url = SECRET_URL;
      await recordCheck(c.db, m!.id, down, { url, startedAt: t(0), alerts: true });
      await recordCheck(c.db, m!.id, { ...down, errorKind: "tls" }, { url, startedAt: t(1000), alerts: true });
      await recordCheck(c.db, m!.id, ok, { url, startedAt: t(61_000), alerts: true });
      const p = fakeProvider();
      const d = mkDispatcher(p.transport);
      await pump(d);
      await pump(d);
      expect(p.calls).toHaveLength(2);
      for (const msg of p.calls) {
        const all = `${msg.subject}\n${msg.text}\n${msg.html}`;
        expect(all).not.toMatch(/segredo-interno|SUPERSECRETO|token|cookie|pulse_session|https?:\/\/|\bat \S+\.ts:\d+|Error:/i);
        expect(all).toContain("Painel");
      }
      expect(p.calls[0]!.text).toContain("falha de TLS/certificado"); // categoria da falha que abriu o incidente
    });

    it("monitor excluído antes do envio: o evento some em cascata e nada é enviado", async () => {
      const [m] = await seedEvents(1);
      await c.db.monitor.delete({ where: { id: m!.id } });
      const p = fakeProvider();
      await pump(mkDispatcher(p.transport));
      expect(p.calls).toHaveLength(0);
      expect(await events()).toHaveLength(0);
    });

    it("modo log: marca como enviado sem nenhuma chamada de rede e registra o e-mail renderizado no log", async () => {
      await seedEvents(1);
      const lines: { o: Record<string, unknown>; msg: string }[] = [];
      const log = { info: (o: Record<string, unknown>, msg: string) => lines.push({ o, msg }), warn() {}, error() {}, debug() {}, trace() {}, fatal() {} } as unknown as FastifyBaseLogger;
      await pump(mkDispatcher(createLogTransport(log)));
      expect((await events())[0]!.status).toBe("SENT");
      const entry = lines.find((l) => l.msg.includes("NOT sent"))!;
      expect(entry.o.subject).toBe("[Pulse] ALERTA: seed0 está indisponível");
    });
  });

  describe("falha do provedor e retentativas", () => {
    it("falha temporária: o evento continua pendente, registra a categoria e só tenta de novo depois da espera", async () => {
      await seedEvents(1);
      const p = fakeProvider((_m, n) => (n === 1 ? { ok: false, kind: "rate_limited", httpStatus: 429 } : { ok: true, messageId: "msg_ok" }));
      const d = mkDispatcher(p.transport, { backoffSeconds: [3600] });
      await pump(d);
      const [e] = await events();
      expect(e).toMatchObject({ status: "PENDING", attempts: 1, lastErrorKind: "rate_limited", lockedUntil: null });
      expect(e!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
      await pump(d); // dentro da espera: não tenta
      expect(p.calls).toHaveLength(1);
    });

    it("passada a espera, reenvia e conclui; o erro anterior é limpo", async () => {
      await seedEvents(1);
      const p = fakeProvider((_m, n) => (n === 1 ? { ok: false, kind: "timeout" } : { ok: true, messageId: "msg_ok" }));
      const d = mkDispatcher(p.transport);
      await pump(d);
      await sleep(80);
      await pump(d);
      expect(p.calls).toHaveLength(2);
      expect(p.calls[1]!.idempotencyKey).toBe(p.calls[0]!.idempotencyKey); // mesma chave: o provedor deduplica
      const [e] = await events();
      expect(e).toMatchObject({ status: "SENT", attempts: 2, providerMessageId: "msg_ok", lastErrorKind: null });
    });

    it("transporte que lança exceção é tratado como falha (sem vazar a mensagem) e será repetido", async () => {
      await seedEvents(1);
      const p = fakeProvider(() => {
        throw new Error("senha=hunter2 conexão com 10.0.0.5");
      });
      await pump(mkDispatcher(p.transport));
      const [e] = await events();
      expect(e).toMatchObject({ status: "PENDING", attempts: 1, lastErrorKind: "unknown" });
      expect(JSON.stringify(e)).not.toMatch(/hunter2|10\.0\.0\.5/);
    });

    it("limite de tentativas: esgotado, vira FAILED e nunca mais é tentado", async () => {
      await seedEvents(1);
      const p = fakeProvider(() => ({ ok: false, kind: "server_error", httpStatus: 500 }));
      const d = mkDispatcher(p.transport, { maxAttempts: 3, backoffSeconds: [0.02] });
      for (let i = 0; i < 8; i++) (await pump(d), await sleep(40));
      expect(p.calls).toHaveLength(3);
      const [e] = await events();
      expect(e).toMatchObject({ status: "FAILED", attempts: 3, lastErrorKind: "server_error" });
    });

    it("a espera cresce entre as tentativas (backoff) e repete o último valor", async () => {
      await seedEvents(1);
      const p = fakeProvider(() => ({ ok: false, kind: "network" }));
      const d = mkDispatcher(p.transport, { maxAttempts: 9, backoffSeconds: [100, 500] });
      const waits: number[] = [];
      for (let i = 0; i < 3; i++) {
        await pump(d);
        const [e] = await events();
        waits.push(Math.round((e!.nextAttemptAt.getTime() - Date.now()) / 1000));
        await c.db.alertEvent.update({ where: { id: e!.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      }
      expect(waits.map((w) => Math.round(w / 100) * 100)).toEqual([100, 500, 500]);
    });

    it("reinício do processo: um novo dispatcher continua de onde o anterior parou", async () => {
      await seedEvents(2);
      const fail = fakeProvider(() => ({ ok: false, kind: "server_error", httpStatus: 502 }));
      const first = mkDispatcher(fail.transport);
      await pump(first);
      await first.stop(); // "processo morre"
      expect((await events()).every((e) => e.status === "PENDING" && e.attempts === 1)).toBe(true);

      await sleep(80);
      const ok2 = fakeProvider();
      const second = mkDispatcher(ok2.transport); // "processo novo"
      await pump(second);
      expect(ok2.calls).toHaveLength(2);
      expect((await events()).every((e) => e.status === "SENT" && e.attempts === 2)).toBe(true);
    });

    it("o evento continua na base mesmo que o provedor fique fora por muito tempo (nada se perde antes do limite)", async () => {
      await seedEvents(1);
      const p = fakeProvider(() => ({ ok: false, kind: "unauthorized", httpStatus: 401 }));
      const d = mkDispatcher(p.transport, { maxAttempts: 7, backoffSeconds: [0.01] });
      for (let i = 0; i < 4; i++) (await pump(d), await sleep(30));
      expect((await events())[0]!.status).toBe("PENDING");
    });
  });

  describe("sem duplicidade", () => {
    it("quatro instâncias disputando 12 alertas: cada alerta é enviado exatamente uma vez", async () => {
      await seedEvents(12);
      // Alarga a janela de corrida: cada UPDATE em alert_events segura o lock por 15 ms.
      await c.db.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION pulse_test_slow_alert() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(0.015); RETURN NEW; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER pulse_test_slow_alert_trg BEFORE UPDATE ON alert_events FOR EACH ROW EXECUTE FUNCTION pulse_test_slow_alert();`);
      try {
        const p = fakeProvider(async () => (await sleep(10), { ok: true, messageId: "m" }));
        const ds = Array.from({ length: 4 }, () => mkDispatcher(p.transport, { concurrency: 12, maxPerHour: 1000 }));
        await Promise.all(ds.map((d) => d.tick())); // as quatro reivindicam ao mesmo tempo
        await Promise.all(ds.map((d) => d.idle()));
        await waitFor(async () => (await c.db.alertEvent.count({ where: { status: "SENT" } })) === 12, 8000);
        await sleep(200);
        const perKey = new Map<string, number>();
        for (const m of p.calls) perKey.set(m.idempotencyKey, (perKey.get(m.idempotencyKey) ?? 0) + 1);
        expect(perKey.size).toBe(12);
        expect([...perKey.values()].filter((n) => n !== 1)).toEqual([]);
        expect((await events()).every((e) => e.attempts === 1)).toBe(true);
      } finally {
        await c.db.$executeRawUnsafe("DROP TRIGGER pulse_test_slow_alert_trg ON alert_events; DROP FUNCTION pulse_test_slow_alert();");
      }
    });

    it("enquanto uma instância envia (lease ativo) nenhuma outra pega o mesmo evento; expirado o lease, outra assume", async () => {
      await seedEvents(1);
      await c.db.alertEvent.updateMany({ data: { attempts: 1, lockedUntil: new Date(Date.now() + 60_000) } });
      const p = fakeProvider();
      await pump(mkDispatcher(p.transport));
      expect(p.calls).toHaveLength(0);

      await c.db.alertEvent.updateMany({ data: { lockedUntil: new Date(Date.now() - 1000) } }); // processo anterior morreu
      await pump(mkDispatcher(p.transport));
      expect(p.calls).toHaveLength(1);
      expect((await events())[0]).toMatchObject({ status: "SENT", attempts: 2 });
    });

    it("o provedor aceitou o e-mail mas o banco falhou ao registrar: o reenvio usa a MESMA chave e o provedor entrega uma vez só", async () => {
      await seedEvents(1);
      const p = fakeProvider();
      await c.db.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION pulse_test_fail_sent() RETURNS trigger AS $$ BEGIN IF NEW.status = 'SENT' THEN RAISE EXCEPTION 'falha simulada'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER pulse_test_fail_sent_trg BEFORE UPDATE ON alert_events FOR EACH ROW EXECUTE FUNCTION pulse_test_fail_sent();`);
      const d = mkDispatcher(p.transport, { leaseMs: 150 });
      try {
        await pump(d);
        expect(p.calls).toHaveLength(1); // o provedor recebeu
        expect((await events())[0]!.status).toBe("PENDING"); // mas o resultado não foi gravado
      } finally {
        await c.db.$executeRawUnsafe("DROP TRIGGER pulse_test_fail_sent_trg ON alert_events; DROP FUNCTION pulse_test_fail_sent();");
      }
      await sleep(200); // lease expira
      await pump(d);
      expect(p.calls).toHaveLength(2);
      expect(p.calls[1]!.idempotencyKey).toBe(p.calls[0]!.idempotencyKey);
      expect(p.delivered.size).toBe(1); // o provedor deduplicou: UM e-mail
      expect((await events())[0]!.status).toBe("SENT");
    });
  });

  describe("limites e isolamento", () => {
    it("teto por hora: o excedente espera pendente, sem gastar tentativas", async () => {
      await seedEvents(5);
      const p = fakeProvider();
      const d = mkDispatcher(p.transport, { maxPerHour: 2 });
      for (let i = 0; i < 4; i++) await pump(d);
      expect(p.calls).toHaveLength(2);
      const ev = await events();
      expect(ev.filter((e) => e.status === "SENT")).toHaveLength(2);
      expect(ev.filter((e) => e.status === "PENDING" && e.attempts === 0)).toHaveLength(3);
    });

    it("provedor lento NÃO atrasa o scheduler de checagens", async () => {
      await seedEvents(1);
      await mkMonitors(c.db, 5, { prefix: "chk" });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const p = fakeProvider(async () => (await gate, { ok: true, messageId: "m" }));
      const d = mkDispatcher(p.transport);
      const s = new Scheduler(c.db, c.app.log, { tickMs: 3_600_000, concurrency: 5, timeoutMs: 1000, retentionDays: 30, alertsEnabled: true, check: async () => ok });
      d.start();
      await waitFor(async () => p.calls.length === 1); // o envio está pendurado no provedor
      s.start();
      await waitFor(async () => (await c.db.checkResult.count()) === 5, 3000); // as checagens andam normalmente
      expect(p.delivered.size).toBe(0);
      release();
      await waitFor(async () => (await c.db.alertEvent.count({ where: { status: "SENT" } })) === 1);
      await Promise.all([s.stop(), d.stop()]);
    });

    it("de ponta a ponta: scheduler detecta 2 falhas → 1 e-mail; recuperação → 1 e-mail com duração; falhas extras não enviam nada", async () => {
      const [m] = await mkMonitors(c.db, 1, { intervalSeconds: 30 });
      let healthy = false;
      const p = fakeProvider();
      const d = mkDispatcher(p.transport);
      const s = new Scheduler(c.db, c.app.log, { tickMs: 3_600_000, concurrency: 5, timeoutMs: 1000, retentionDays: 30, alertsEnabled: true, check: async () => (healthy ? ok : down) });
      const runOnce = async () => {
        await c.db.monitor.update({ where: { id: m!.id }, data: { nextCheckAt: new Date(Date.now() - 1000) } });
        s.start();
        await sleep(60);
        await s.stop();
        await s.idle();
      };
      for (let i = 0; i < 6; i++) await runOnce(); // 6 falhas seguidas
      await pump(d);
      expect(p.calls).toHaveLength(1);
      expect(p.calls[0]!.subject).toContain("ALERTA");

      healthy = true;
      await runOnce();
      await pump(d);
      expect(p.calls).toHaveLength(2);
      expect(p.calls[1]!.subject).toMatch(/^\[Pulse\] Resolvido: chk|^\[Pulse\] Resolvido: m0/);
      expect(p.calls[1]!.text).toMatch(/Duração: \d+ s|Duração: \d+ min/);
      await pump(d);
      expect(p.calls).toHaveLength(2);
    });
  });
});
