import { describe, expect, it } from "vitest";
import { effectiveMinIntervalSeconds, loadConfig, workerLateAfterMinutes } from "../src/config.js";
import { redactSecrets, safeError, secretsFromEnv } from "../src/lib/redact.js";

const base = { DATABASE_URL: "postgresql://u:p@h/db", NODE_ENV: "development" };

describe("config do worker", () => {
  it("variáveis vazias (segredo ausente no GitHub chega como \"\") contam como ausentes", () => {
    const c = loadConfig({ ...base, WORKER_TIMEOUT_SECONDS: "", ALERT_DELIVERY: "", RESEND_API_KEY: "", WORKER_EXPECTED_INTERVAL_MINUTES: "" });
    expect(c.WORKER_TIMEOUT_SECONDS).toBe(240);
    expect(c.ALERT_DELIVERY).toBe("off");
    expect(c.WORKER_EXPECTED_INTERVAL_MINUTES).toBeUndefined();
  });

  it("tempo total precisa caber o timeout da checagem + folga", () => {
    expect(() => loadConfig({ ...base, WORKER_TIMEOUT_SECONDS: "60", CHECK_TIMEOUT_MS: "30000" })).toThrow(/WORKER_TIMEOUT_SECONDS/);
  });

  it("limiar de atraso: 3× a cadência, ou o valor explícito", () => {
    expect(workerLateAfterMinutes(loadConfig({ ...base, WORKER_EXPECTED_INTERVAL_MINUTES: "15" }))).toBe(45);
    expect(workerLateAfterMinutes(loadConfig({ ...base, WORKER_EXPECTED_INTERVAL_MINUTES: "15", WORKER_LATE_AFTER_MINUTES: "30" }))).toBe(30);
    expect(workerLateAfterMinutes(loadConfig(base))).toBeNull();
  });

  it("menor intervalo efetivo: nunca menor que o timeout da checagem", () => {
    expect(effectiveMinIntervalSeconds(loadConfig({ ...base, MIN_INTERVAL_SECONDS: "900" }))).toBe(900);
    expect(effectiveMinIntervalSeconds(loadConfig({ ...base, MIN_INTERVAL_SECONDS: "30", CHECK_TIMEOUT_MS: "40000", WORKER_TIMEOUT_SECONDS: "300" }))).toBe(41);
  });
});

describe("redação de segredos", () => {
  const env = { DATABASE_URL: "postgresql://neon:SenhaSuperSecreta99@ep-x.neon.tech/db?sslmode=require", RESEND_API_KEY: "re_abcdefghijklmnop" };
  const secrets = secretsFromEnv(env);

  it("remove senha da URL, a URL inteira e a chave do Resend", () => {
    const out = redactSecrets(`falhou em ${env.DATABASE_URL} usando SenhaSuperSecreta99 e ${env.RESEND_API_KEY} e re_zzzzzzzzzzzz`, secrets);
    expect(out).not.toMatch(/SenhaSuperSecreta99|re_abcdefghijklmnop|re_zzzzzzzzzzzz/);
  });

  it("safeError nunca devolve stack e redige a mensagem", () => {
    const e = safeError(new Error(`connect failed postgresql://a:SenhaSuperSecreta99@h/db`), secrets);
    expect(JSON.stringify(e)).not.toContain("SenhaSuperSecreta99");
    expect(JSON.stringify(e)).not.toContain("stack");
  });
});
