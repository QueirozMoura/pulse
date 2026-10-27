import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailTransport, SendResult } from "../src/alerts/transports.js";
import type { CheckOutcome } from "../src/checker/http-check.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, type Db } from "../src/lib/db.js";
import { EXIT, runWorkerOnce, type WorkerOptions } from "../src/worker/run-once.js";
import { workerHealth } from "../src/worker/health.js";
import { TEST_DB_URL, down, mkMonitors, ok, resetDb, setup, sleep, type Ctx } from "./helpers.js";

function provider(behavior?: (call: number) => SendResult) {
  const calls: { key: string; subject: string }[] = [];
  const delivered = new Set<string>();
  const transport: EmailTransport = {
    async send(m) {
      calls.push({ key: m.idempotencyKey, subject: m.subject });
      const r = behavior ? behavior(calls.length) : ({ ok: true, messageId: `m${calls.length}` } as const);
      if (r.ok) delivered.add(m.idempotencyKey);
      return r;
    },
  };
  return { calls, delivered, transport };
}

describe.skipIf(!TEST_DB_URL)("worker one-shot (PostgreSQL real)", () => {
  let c: Ctx;
  beforeAll(async () => void (c = await setup()));
  afterAll(() => c.close());
  beforeEach(() => resetDb(c.db));

  const opts = (over: Partial<WorkerOptions> = {}): WorkerOptions => ({
    timeoutMs: 20_000,
    maxChecks: 200,
    concurrency: 5,
    checkTimeoutMs: 1000,
    dueSlackSeconds: 0,
    retentionDays: 30,
    alerts: null,
    check: async () => ok,
    ...over,
  });
  const run = (over: Partial<WorkerOptions> = {}, db: Db = c.db) => runWorkerOnce(db, c.app.log, opts(over));
  const checks = () => c.db.checkResult.count();
  const withAlerts = (p: ReturnType<typeof provider>, extra: Partial<NonNullable<WorkerOptions["alerts"]>> = {}) => ({
    transport: p.transport, to: "a@exemplo.com", from: "Pulse <p@exemplo.com>", maxPerHour: 100, backoffSeconds: [0.05], ...extra,
  });

  describe("checagens", () => {
    it("checa só os vencidos, uma vez, e termina com código 0", async () => {
      await mkMonitors(c.db, 3, { prefix: "due" });
      await mkMonitors(c.db, 2, { prefix: "later", nextCheckAt: new Date(Date.now() + 3_600_000) });
      await mkMonitors(c.db, 1, { prefix: "paused", active: false });
      const r = await run();
      expect(r).toMatchObject({ status: "ok", exitCode: EXIT.OK });
      expect(r.checks).toMatchObject({ claimed: 3, recorded: 3 });
      expect(await checks()).toBe(3);
      expect(await c.db.checkResult.count({ where: { monitor: { name: { startsWith: "later" } } } })).toBe(0);
    });

    it("execução manual repetida é idempotente: a segunda não acha nada vencido", async () => {
      await mkMonitors(c.db, 4, { intervalSeconds: 900 });
      await run();
      const r2 = await run();
      expect(r2.checks).toMatchObject({ claimed: 0 });
      expect(r2.exitCode).toBe(EXIT.OK);
      expect(await checks()).toBe(4);
    });

    it("monitor de 15 min não é pulado por o cron ter disparado alguns minutos antes (folga)", async () => {
      // Checado há 12 min num intervalo de 15: vence daqui a 3 min. Sem folga seria pulado e esperaria mais 15 min.
      await mkMonitors(c.db, 1, { intervalSeconds: 900, nextCheckAt: new Date(Date.now() + 180_000) });
      expect((await run({ dueSlackSeconds: 0 })).checks?.claimed).toBe(0);
      expect((await run({ dueSlackSeconds: 300 })).checks?.claimed).toBe(1);
      // E depois fica reagendado a partir de agora (não acumula atraso nem repete na rodada seguinte).
      expect((await run({ dueSlackSeconds: 300 })).checks?.claimed).toBe(0);
    });

    it("rodada limitada: maxChecks trunca, sai com 0 e a rodada seguinte continua de onde parou (reinício)", async () => {
      await mkMonitors(c.db, 7);
      const r1 = await run({ maxChecks: 3 });
      expect(r1).toMatchObject({ status: "truncated", exitCode: EXIT.OK });
      expect(r1.checks?.claimed).toBe(3);
      const r2 = await run({ maxChecks: 3 });
      const r3 = await run({ maxChecks: 3 });
      expect([r2.checks?.claimed, r3.checks?.claimed]).toEqual([3, 1]);
      expect(await checks()).toBe(7);
      expect(await c.db.checkResult.groupBy({ by: ["monitorId"], _count: true })).toHaveLength(7); // nenhum em dobro
    });

    it("reinício após morte no meio: monitores já reivindicados não repetem; os não reivindicados são retomados", async () => {
      await mkMonitors(c.db, 6);
      const ac = new AbortController();
      let calls = 0;
      const r1 = await run({ concurrency: 1, signal: ac.signal, check: async () => (++calls === 2 && ac.abort(), ok) });
      expect(r1).toMatchObject({ status: "cancelled", exitCode: EXIT.CANCELLED });
      const done = await checks();
      expect(done).toBeGreaterThanOrEqual(2);
      expect(done).toBeLessThan(6);
      const r2 = await run();
      expect(r2.exitCode).toBe(EXIT.OK);
      expect(await checks()).toBe(6);
      expect(await c.db.checkResult.groupBy({ by: ["monitorId"], _count: true })).toHaveLength(6);
    });

    it("duas execuções sobrepostas: cada monitor é checado exatamente uma vez", async () => {
      await mkMonitors(c.db, 24);
      await c.db.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION pulse_test_slow() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(0.015); RETURN NEW; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER pulse_test_slow_trg BEFORE UPDATE ON monitors FOR EACH ROW EXECUTE FUNCTION pulse_test_slow();`);
      const db2 = createDb(TEST_DB_URL!);
      try {
        const seen: string[] = [];
        const check = async (u: string): Promise<CheckOutcome> => (seen.push(u), ok);
        const [a, b] = await Promise.all([run({ check, concurrency: 3 }), run({ check, concurrency: 3 }, db2)]);
        expect(a.exitCode + b.exitCode).toBe(0);
        expect((a.checks?.claimed ?? 0) + (b.checks?.claimed ?? 0)).toBe(24);
        expect(new Set(seen).size).toBe(24);
        expect(seen).toHaveLength(24);
        expect(await checks()).toBe(24);
        expect(await c.db.workerRun.count({ where: { status: "ok" } })).toBe(2);
      } finally {
        await c.db.$executeRawUnsafe("DROP TRIGGER IF EXISTS pulse_test_slow_trg ON monitors; DROP FUNCTION IF EXISTS pulse_test_slow()");
        await db2.$disconnect();
      }
    });

    it("falha parcial: um monitor não consegue gravar → exit 1, os demais são gravados", async () => {
      const ms = await mkMonitors(c.db, 4);
      await c.db.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION pulse_test_fail() RETURNS trigger AS $$ BEGIN
          IF NEW.monitor_id = '${ms[1]!.id}'::uuid THEN RAISE EXCEPTION 'falha simulada'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER pulse_test_fail_trg BEFORE INSERT ON check_results FOR EACH ROW EXECUTE FUNCTION pulse_test_fail();`);
      try {
        const r = await run();
        expect(r).toMatchObject({ status: "failed", exitCode: EXIT.FAILED });
        expect(r.checks).toMatchObject({ claimed: 4, recorded: 3, errors: 1 });
        expect(await checks()).toBe(3);
        const hb = await c.db.workerRun.findFirstOrThrow();
        expect(hb).toMatchObject({ status: "failed", errors: 1 });
      } finally {
        await c.db.$executeRawUnsafe("DROP TRIGGER IF EXISTS pulse_test_fail_trg ON check_results; DROP FUNCTION IF EXISTS pulse_test_fail()");
      }
    });

    it("timeout total: checagem pendurada → exit 3, termina rápido e o prazo é respeitado", async () => {
      await mkMonitors(c.db, 2);
      const t0 = Date.now();
      const r = await run({ timeoutMs: 1500, checkTimeoutMs: 200, check: () => new Promise(() => undefined) });
      expect(r).toMatchObject({ status: "timeout", exitCode: EXIT.TIMEOUT });
      expect(Date.now() - t0).toBeLessThan(2500);
      expect((await c.db.workerRun.findFirstOrThrow()).status).toBe("timeout");
    });

    it("cancelamento (SIGTERM) antes de começar: nada é reivindicado, exit 130, batimento gravado", async () => {
      await mkMonitors(c.db, 3);
      const ac = new AbortController();
      ac.abort();
      const r = await run({ signal: ac.signal });
      expect(r).toMatchObject({ status: "cancelled", exitCode: EXIT.CANCELLED });
      expect(await checks()).toBe(0);
      expect((await c.db.workerRun.findFirstOrThrow()).finishedAt).not.toBeNull();
    });
  });

  describe("outbox de alertas", () => {
    /** Dois monitores caindo: 1ª rodada = 1ª falha; 2ª rodada abre o incidente (2 falhas) e cria o alerta. */
    async function openIncident(p: ReturnType<typeof provider>, extra: Partial<WorkerOptions> = {}) {
      const [m] = await mkMonitors(c.db, 1, { intervalSeconds: 900 });
      const o = { check: async () => down, alerts: withAlerts(p), ...extra };
      await run(o);
      await c.db.monitor.update({ where: { id: m!.id }, data: { nextCheckAt: new Date(Date.now() - 1000) } });
      return { m: m!, o };
    }

    it("a transição abre incidente e o alerta sai na MESMA rodada; rodar de novo não reenvia", async () => {
      const p = provider();
      const { o } = await openIncident(p);
      const r = await run(o);
      expect(r.alerts).toMatchObject({ sent: 1, failed: 0 });
      expect(p.calls).toHaveLength(1);
      expect(p.calls[0]!.subject).toContain("ALERTA");
      const again = await run(o);
      expect(again.alerts).toMatchObject({ sent: 0, retried: 0 });
      expect(p.calls).toHaveLength(1);
    });

    it("provedor fora do ar: exit 0 (esperado), evento fica PENDING com retentativa; depois de voltar, envia", async () => {
      const p = provider((n) => (n <= 1 ? { ok: false, kind: "network" } : { ok: true, messageId: "m" }));
      const { m, o } = await openIncident(p);
      const r1 = await run(o);
      expect(r1.alerts).toMatchObject({ sent: 0, retried: 1 });
      expect(r1.exitCode).toBe(EXIT.OK);
      expect((await c.db.alertEvent.findFirstOrThrow()).status).toBe("PENDING");
      await sleep(120); // vence o backoff (50 ms)
      await c.db.monitor.update({ where: { id: m.id }, data: { nextCheckAt: new Date(Date.now() - 1000) } }); // volta a ficar vencido
      const r2 = await run({ ...o, check: async () => ok, alerts: withAlerts(p) });
      expect(r2.alerts?.sent).toBeGreaterThanOrEqual(1);
      expect(p.delivered.size).toBe(2); // "aberto" (na 2ª tentativa) e depois "resolvido"
    });

    it("esgota as tentativas → FAILED, contado na rodada, sem laço infinito", async () => {
      const p = provider(() => ({ ok: false, kind: "rejected", httpStatus: 422 }));
      const { o } = await openIncident(p, { alerts: withAlerts(provider(() => ({ ok: false, kind: "rejected", httpStatus: 422 })), { maxAttempts: 2 }) });
      const bad = withAlerts(p, { maxAttempts: 2 });
      await run({ ...o, alerts: bad });
      await sleep(120);
      const r = await run({ ...o, alerts: bad });
      expect(r.alerts?.failed).toBe(1);
      expect((await c.db.alertEvent.findFirstOrThrow()).status).toBe("FAILED");
      expect(p.calls.length).toBeLessThanOrEqual(2);
    });

    it("duas execuções sobrepostas enviam cada alerta uma única vez", async () => {
      const p = provider();
      // 6 incidentes já com evento pendente
      const ms = await mkMonitors(c.db, 6, { prefix: "ev", nextCheckAt: new Date(Date.now() + 3_600_000) });
      for (const m of ms) {
        const inc = await c.db.incident.create({ data: { monitorId: m.id, startedAt: new Date() } });
        await c.db.alertEvent.create({ data: { incidentId: inc.id, kind: "OPENED" } });
      }
      const db2 = createDb(TEST_DB_URL!);
      try {
        const alerts = withAlerts(p, { concurrency: 2 });
        const [a, b] = await Promise.all([run({ alerts }), run({ alerts }, db2)]);
        expect((a.alerts?.sent ?? 0) + (b.alerts?.sent ?? 0)).toBe(6);
        expect(p.calls).toHaveLength(6);
        expect(new Set(p.calls.map((x) => x.key)).size).toBe(6);
        expect(await c.db.alertEvent.count({ where: { status: "SENT" } })).toBe(6);
      } finally {
        await db2.$disconnect();
      }
    });

    it("alertas desligados (alerts: null): checa, mas não cria nem envia nada", async () => {
      const [m] = await mkMonitors(c.db, 1, { intervalSeconds: 900 });
      await run({ check: async () => down });
      await c.db.monitor.update({ where: { id: m!.id }, data: { nextCheckAt: new Date(Date.now() - 1000) } });
      const r = await run({ check: async () => down });
      expect(r.alerts).toBeNull();
      expect(await c.db.incident.count()).toBe(1);
      expect(await c.db.alertEvent.count()).toBe(0);
    });
  });

  describe("batimento e /health", () => {
    const cfg = { expectedEveryMinutes: 15, lateAfterMinutes: 45 };

    it("never → ok → late, calculado só a partir de rodadas bem-sucedidas", async () => {
      expect((await workerHealth(c.db, cfg)).status).toBe("never");
      await run();
      const h = await workerHealth(c.db, cfg);
      expect(h).toMatchObject({ status: "ok", expectedEveryMinutes: 15 });
      expect(h.ageSeconds).toBeLessThan(10);
      const later = Date.now() + 46 * 60_000;
      expect((await workerHealth(c.db, cfg, later)).status).toBe("late");
    });

    it("rodada que falhou não conta como sucesso (a API no ar não esconde o worker doente)", async () => {
      await mkMonitors(c.db, 1);
      await c.db.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION pulse_test_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'x'; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER pulse_test_fail_trg BEFORE INSERT ON check_results FOR EACH ROW EXECUTE FUNCTION pulse_test_fail();`);
      try {
        expect((await run()).exitCode).toBe(EXIT.FAILED);
      } finally {
        await c.db.$executeRawUnsafe("DROP TRIGGER IF EXISTS pulse_test_fail_trg ON check_results; DROP FUNCTION IF EXISTS pulse_test_fail()");
      }
      const h = await workerHealth(c.db, cfg);
      expect(h.status).toBe("never");
      expect(h.lastRun?.status).toBe("failed");
    });

    it("/health: 200 mesmo com worker atrasado (a Render não reinicia a API por atraso do GitHub); worker.status = late", async () => {
      await c.db.workerRun.create({
        data: { status: "ok", startedAt: new Date(Date.now() - 3 * 3_600_000), finishedAt: new Date(Date.now() - 3 * 3_600_000) },
      });
      const app = buildApp(
        loadConfig({ DATABASE_URL: TEST_DB_URL!, NODE_ENV: "development", LOG_LEVEL: "silent", SCHEDULER_ENABLED: "false", WORKER_EXPECTED_INTERVAL_MINUTES: "15" }),
        c.db,
      );
      const res = await app.inject({ url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "ok", scheduler: "disabled", worker: { status: "late", expectedEveryMinutes: 15, lateAfterMinutes: 45 } });
      expect(res.json().worker.ageSeconds).toBeGreaterThan(3 * 3600 - 60);
      await app.close();
    });

    it("sem WORKER_EXPECTED_INTERVAL_MINUTES o bloco worker não aparece; /health/live não toca no banco", async () => {
      const broken = createDb("postgresql://x:y@127.0.0.1:1/none", { connectionTimeoutMs: 300 });
      const app = buildApp(loadConfig({ DATABASE_URL: "postgresql://x:y@127.0.0.1:1/none", NODE_ENV: "development", LOG_LEVEL: "silent", SCHEDULER_ENABLED: "false" }), broken);
      const live = await app.inject({ url: "/health/live" });
      expect(live.statusCode).toBe(200);
      expect(live.json()).toEqual({ status: "ok" });
      const full = await app.inject({ url: "/health" });
      expect(full.statusCode).toBe(503);
      expect(full.json()).not.toHaveProperty("worker");
      await app.close();
      await broken.$disconnect();
    });
  });
});
