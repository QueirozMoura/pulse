import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { CheckOutcome } from "../src/checker/http-check.js";
import type { Db } from "../src/lib/db.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { purgeOldChecks } from "../src/services/retention.js";
import { TEST_DB_URL, mkMonitors, ok, resetDb, setup, sleep, waitFor, type Ctx } from "./helpers.js";

describe.skipIf(!TEST_DB_URL)("scheduler (PostgreSQL real)", () => {
  let c: Ctx;
  beforeAll(async () => void (c = await setup()));
  afterAll(() => c.close());
  beforeEach(() => resetDb(c.db));

  const make = (db: Db, check: (url: string) => Promise<CheckOutcome>, over: Partial<ConstructorParameters<typeof Scheduler>[2]> = {}) =>
    new Scheduler(db, c.app.log, { tickMs: 60_000, concurrency: 10, timeoutMs: 1000, retentionDays: 30, check, ...over });
  const checks = () => c.db.checkResult.count();

  it("monitor vencido há 1 hora (processo ficou fora do ar) recebe UMA checagem, não uma por intervalo perdido", async () => {
    const [m] = await mkMonitors(c.db, 1, { intervalSeconds: 30, nextCheckAt: new Date(Date.now() - 3_600_000) });
    const calls: string[] = [];
    const s = make(c.db, async (u) => (calls.push(u), ok));
    s.start();
    await sleep(100);
    await s.tick();
    await s.idle();
    await s.stop();
    expect(calls).toHaveLength(1);
    expect(await checks()).toBe(1);
    const after = await c.db.monitor.findUniqueOrThrow({ where: { id: m!.id } });
    expect(after.nextCheckAt.getTime()).toBeGreaterThan(Date.now() + 20_000); // reagendado a partir de agora
  });

  it("duas instâncias disputando os mesmos monitores: cada monitor é checado exatamente uma vez", async () => {
    await mkMonitors(c.db, 24);
    // Alarga a janela de corrida de forma determinística: cada UPDATE em monitors segura o lock por 15 ms.
    // Sem FOR UPDATE SKIP LOCKED, a 2ª instância esperaria o lock e reivindicaria as mesmas linhas de novo.
    await c.db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION pulse_test_slow() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(0.015); RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER pulse_test_slow_trg BEFORE UPDATE ON monitors FOR EACH ROW EXECUTE FUNCTION pulse_test_slow();`);
    try {
      const calls = new Map<string, number>();
      const check = async (u: string) => (calls.set(u, (calls.get(u) ?? 0) + 1), await sleep(20), ok);
      const a = make(c.db, check, { concurrency: 24 });
      const b = make(c.db, check, { concurrency: 24 });
      a.start();
      b.start(); // os dois primeiros ciclos reivindicam ao mesmo tempo
      await waitFor(async () => (await checks()) >= 24, 8000);
      await sleep(300); // dá tempo de uma eventual checagem duplicada aparecer
      await Promise.all([a.stop(), b.stop()]);
      expect(calls.size).toBe(24);
      expect([...calls.values()].filter((n) => n !== 1)).toEqual([]);
      expect(await checks()).toBe(24);
    } finally {
      await c.db.$executeRawUnsafe("DROP TRIGGER pulse_test_slow_trg ON monitors; DROP FUNCTION pulse_test_slow();");
    }
  });

  it("checagem lenta ocupa só a própria vaga: as demais seguem sem esperar por ela", async () => {
    await mkMonitors(c.db, 8);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = make(c.db, async (u) => (u.includes("//m0.") ? (await gate, ok) : ok), { concurrency: 3 });
    s.start();
    await waitFor(async () => (await checks()) === 7, 5000); // 7 de 8 prontos com m0 ainda travada
    expect(await checks()).toBe(7);
    release();
    await waitFor(async () => (await checks()) === 8);
    await s.stop();
  });

  it("falha do banco ao reivindicar: não lança, sinaliza 'stalled' e se recupera sozinho", async () => {
    await mkMonitors(c.db, 1);
    let fail = true;
    const flaky = new Proxy(c.db, {
      get: (t, p, r) => (p === "$queryRaw" && fail ? async () => { throw new Error("db down"); } : Reflect.get(t, p, r)),
    }) as Db;
    const s = make(flaky, async () => ok, { tickMs: 1000 });

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      s.start(); // dispara um tick que falha
      await vi.advanceTimersByTimeAsync(0);
      expect(s.status()).toBe("ok"); // recém-iniciado
      vi.setSystemTime(Date.now() + 60_000);
      await s.tick();
      expect(s.status()).toBe("stalled");
      expect(await checks()).toBe(0);
    } finally {
      vi.useRealTimers();
    }

    fail = false;
    await s.tick();
    await s.idle();
    expect(s.status()).toBe("ok");
    expect(await checks()).toBe(1);
    await s.stop();
  });

  it("banco falha ao GRAVAR depois de checar: a checagem é perdida, nunca repetida nem duplicada", async () => {
    const [m] = await mkMonitors(c.db, 1);
    // Falha real de escrita no Postgres: um trigger temporário rejeita o INSERT em check_results.
    await c.db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION pulse_test_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'disk full (simulado)'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER pulse_test_fail_trg BEFORE INSERT ON check_results FOR EACH ROW EXECUTE FUNCTION pulse_test_fail();`);
    try {
      let calls = 0;
      const s = make(c.db, async () => (calls++, ok));
      s.start();
      await waitFor(async () => calls === 1);
      await s.idle();
      await s.tick(); // o monitor já foi reagendado: nada vencido
      await s.idle();
      await s.stop();
      expect(calls).toBe(1);
      expect(await checks()).toBe(0);
      expect((await c.db.monitor.findUniqueOrThrow({ where: { id: m!.id } })).nextCheckAt.getTime()).toBeGreaterThan(Date.now());
      expect(s.status()).toBe("ok"); // o processo segue de pé
    } finally {
      await c.db.$executeRawUnsafe("DROP TRIGGER pulse_test_fail_trg ON check_results; DROP FUNCTION pulse_test_fail();");
    }
  });

  it("monitor pausado ou excluído nunca é reivindicado", async () => {
    await mkMonitors(c.db, 2, { active: false, prefix: "p" });
    await mkMonitors(c.db, 1, { prefix: "a" }); // controle: o ativo É checado, provando que o scheduler está rodando
    const calls: string[] = [];
    const s = make(c.db, async (u) => (calls.push(u), ok));
    s.start();
    await waitFor(async () => calls.length >= 1);
    await sleep(150);
    await s.tick();
    await s.idle();
    await s.stop();
    expect(calls).toEqual(["https://a0.example.com/"]);
  });

  it("stop() espera as checagens em andamento terminarem", async () => {
    await mkMonitors(c.db, 1);
    const s = make(c.db, async () => (await sleep(200), ok));
    s.start();
    await sleep(50);
    await s.stop();
    expect(await checks()).toBe(1);
  });
});

describe.skipIf(!TEST_DB_URL)("retenção de checagens (PostgreSQL real)", () => {
  let c: Ctx;
  beforeAll(async () => void (c = await setup()));
  afterAll(() => c.close());
  beforeEach(() => resetDb(c.db));

  it("apaga só as mais antigas que o limite, em lotes", async () => {
    const [m] = await mkMonitors(c.db, 1);
    const day = 86_400_000;
    await c.db.checkResult.createMany({
      data: [
        ...Array.from({ length: 7 }, (_, i) => ({ monitorId: m!.id, success: true, latencyMs: 1, checkedAt: new Date(Date.now() - (40 + i) * day) })),
        ...Array.from({ length: 3 }, (_, i) => ({ monitorId: m!.id, success: true, latencyMs: 1, checkedAt: new Date(Date.now() - (1 + i) * day) })),
      ],
    });
    expect(await purgeOldChecks(c.db, 30, 3)).toBe(7); // 3 lotes: 3 + 3 + 1
    expect(await c.db.checkResult.count()).toBe(3);
    expect(await purgeOldChecks(c.db, 30)).toBe(0);
  });
});
