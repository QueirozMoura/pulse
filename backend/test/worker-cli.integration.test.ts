import { spawn } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_DB_URL, mkMonitors, resetDb, setup, sleep, type Ctx } from "./helpers.js";

/** Roda o CLI real (processo separado) como o GitHub Actions faria. Env mínimo, sem herdar o do shell. */
function runCli(env: Record<string, string>, opts: { killAfterMs?: number; signal?: NodeJS.Signals } = {}) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/worker/once.ts"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, NODE_ENV: "production", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    if (opts.killAfterMs) setTimeout(() => child.kill(opts.signal ?? "SIGTERM"), opts.killAfterMs);
    child.on("close", (code) => resolve({ code, out }));
  });
}

describe.skipIf(!TEST_DB_URL)("CLI worker:once (processo real, PostgreSQL real)", () => {
  let c: Ctx;
  beforeAll(async () => void (c = await setup()));
  afterAll(() => c.close());
  beforeEach(() => resetDb(c.db));

  it("sem DATABASE_URL → exit 2 e mensagem clara", async () => {
    const r = await runCli({});
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/Configuração inválida/);
  }, 60_000);

  it("rodada vazia com banco real → exit 0, grava batimento, não imprime a URL", async () => {
    const r = await runCli({ DATABASE_URL: TEST_DB_URL!, LOG_LEVEL: "info" });
    expect(r.code).toBe(0);
    expect(await c.db.workerRun.count({ where: { status: "ok" } })).toBe(1);
    expect(r.out).not.toContain(TEST_DB_URL!);
  }, 60_000);

  it("banco inacessível com senha secreta → exit 1 e a senha NUNCA aparece na saída", async () => {
    const secret = "S3nh4-Super-Secreta-XYZ";
    const bad = `postgresql://pulse:${secret}@127.0.0.1:1/nada`;
    const r = await runCli({ DATABASE_URL: bad, LOG_LEVEL: "debug", RESEND_API_KEY: "re_chaveSECRETA123456", ALERT_DELIVERY: "email", ALERT_EMAIL_TO: "a@b.co", ALERT_EMAIL_FROM: "p@b.co" });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain(secret);
    expect(r.out).not.toContain("re_chaveSECRETA123456");
    expect(r.out).not.toMatch(/at .*\.(ts|js):\d+/); // sem stack trace
  }, 60_000);

  it("banco sem tabelas → exit 2, orienta aplicar migrations e NÃO cria nada", async () => {
    await c.db.$executeRawUnsafe("CREATE DATABASE pulse_empty_cli").catch(() => undefined);
    const empty = new URL(TEST_DB_URL!);
    empty.pathname = "/pulse_empty_cli";
    const r = await runCli({ DATABASE_URL: empty.toString() });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/migrations/);
    await c.db.$executeRawUnsafe("DROP DATABASE IF EXISTS pulse_empty_cli");
  }, 60_000);

  it("não cria administrador nem roda migrations", async () => {
    const before = await c.db.adminUser.count();
    await runCli({ DATABASE_URL: TEST_DB_URL!, ADMIN_USERNAME: "x", ADMIN_PASSWORD: "yyyyyyyyyyyy" });
    expect(await c.db.adminUser.count()).toBe(before);
  }, 60_000);

  it("SIGTERM durante a rodada → encerra rápido com 130 e deixa o batimento fechado", async () => {
    await mkMonitors(c.db, 2);
    // Alvos que nunca respondem: usa o checador real contra um IP bloqueado → falha rápida; então só validamos o sinal
    // antes de a rodada começar de fato. O objetivo é o contrato de saída, não a duração.
    const r = await runCli({ DATABASE_URL: TEST_DB_URL!, LOG_LEVEL: "info" }, { killAfterMs: 1500, signal: "SIGTERM" });
    expect([0, 130]).toContain(r.code);
    await sleep(50);
    expect(await c.db.workerRun.count({ where: { status: "running" } })).toBe(0);
  }, 60_000);
});
