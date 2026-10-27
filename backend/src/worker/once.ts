/**
 * Worker one-shot: UMA rodada de checagens + alertas e encerra. Feito para o GitHub Actions (agendado).
 *
 *   npm run worker:once            (desenvolvimento)
 *   node dist/worker/once.js       (produção, depois de `npm run build`)
 *
 * NÃO roda migrations, NÃO cria administrador e NÃO imprime segredos (DATABASE_URL, senha, chave do Resend: redigidos).
 *
 * Códigos de saída:
 *   0    rodada concluída (inclui "truncada": o que sobrou fica para a próxima rodada)
 *   1    falha: banco inacessível, erro ao gravar resultados, erro inesperado
 *   2    configuração inválida, ou migrations não aplicadas
 *   3    estourou o tempo total (encerrou o que pôde de forma graciosa)
 *   130  cancelado (SIGINT/SIGTERM, ex.: o GitHub cancelou a execução)
 */
import { appendFileSync } from "node:fs";
import pino from "pino";
import { createLogTransport, createResendTransport } from "../alerts/transports.js";
import { loadConfig } from "../config.js";
import { createDb } from "../lib/db.js";
import { redactSecrets, safeError, secretsFromEnv } from "../lib/redact.js";
import { EXIT, runWorkerOnce, type WorkerAlerts, type WorkerResult } from "./run-once.js";

const secrets = secretsFromEnv(process.env);
const say = (line: string) => process.stdout.write(`${redactSecrets(line, secrets)}\n`);
const fail = (code: number, msg: string): never => {
  say(msg);
  process.exit(code);
};

function writeStepSummary(r: WorkerResult): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const c = r.checks;
  const a = r.alerts;
  const md = [
    `### Pulse worker: ${r.status}`,
    "",
    "| Item | Valor |",
    "|---|---|",
    `| Duração | ${(r.durationMs / 1000).toFixed(1)} s |`,
    `| Monitores checados | ${c?.claimed ?? 0} (gravados: ${(c?.recorded ?? 0) + (c?.stale ?? 0)}, descartados: ${c?.discarded ?? 0}, erros: ${c?.errors ?? 0}) |`,
    `| Truncada (sobraram vencidos) | ${c?.truncated ? "sim" : "não"} |`,
    `| Alertas | enviados ${a?.sent ?? 0}, a retentar ${a?.retried ?? 0}, esgotados ${a?.failed ?? 0} |`,
    "",
  ].join("\n");
  try {
    appendFileSync(path, md);
  } catch {
    /* o resumo é opcional */
  }
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    return fail(EXIT.BAD_CONFIG, `Configuração inválida: ${safeError(err, secrets).message}`);
  }

  const log = pino({
    level: config.LOG_LEVEL,
    base: null, // sem pid/hostname
    serializers: { err: (e: unknown) => safeError(e, secrets) }, // nunca stack, nunca segredo
  });

  const db = createDb(config.DATABASE_URL, { max: config.SCHEDULER_CONCURRENCY + 3, connectionTimeoutMs: 30_000, statementTimeoutMs: 30_000 });
  const controller = new AbortController();
  let signals = 0;
  const onSignal = (name: string) => {
    if (++signals > 1) process.exit(EXIT.CANCELLED); // segundo sinal: sem cerimônia
    log.warn({ signal: name }, "signal received: stopping gracefully");
    controller.abort();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  // Última rede de segurança: o tempo total é inegociável. O desligamento gracioso deveria ter terminado antes.
  const hardKill = setTimeout(() => {
    say(`Tempo total (${config.WORKER_TIMEOUT_SECONDS}s) esgotado: encerrando à força.`);
    process.exit(EXIT.TIMEOUT);
  }, config.WORKER_TIMEOUT_SECONDS * 1000);

  const disconnect = () => Promise.race([db.$disconnect().catch(() => undefined), new Promise((r) => setTimeout(r, 5_000))]);

  let alerts: WorkerAlerts | null = null;
  if (config.ALERT_DELIVERY !== "off") {
    alerts = {
      transport: config.ALERT_DELIVERY === "email" ? createResendTransport(config.RESEND_API_KEY!) : createLogTransport(log),
      to: config.ALERT_EMAIL_TO ?? "dev@localhost",
      from: config.ALERT_EMAIL_FROM ?? "Pulse <pulse@localhost>",
      maxPerHour: config.ALERT_MAX_PER_HOUR,
    };
  }
  const event = process.env.GITHUB_EVENT_NAME;

  try {
    // Pré-requisito: o schema precisa existir. O worker nunca o cria nem o altera.
    try {
      await db.workerRun.count();
    } catch (err) {
      const e = safeError(err, secrets);
      if (e.code === "P2021" || /does not exist|P2021/i.test(e.message)) {
        clearTimeout(hardKill);
        await disconnect();
        return fail(EXIT.BAD_CONFIG, "O banco não tem as tabelas do Pulse. Aplique as migrations a partir do seu computador (npm run db:deploy) antes de rodar o worker.");
      }
      throw err;
    }

    const result = await runWorkerOnce(db, log, {
      timeoutMs: config.WORKER_TIMEOUT_SECONDS * 1000,
      maxChecks: config.WORKER_MAX_CHECKS,
      concurrency: config.SCHEDULER_CONCURRENCY,
      checkTimeoutMs: config.CHECK_TIMEOUT_MS,
      dueSlackSeconds: config.WORKER_DUE_SLACK_SECONDS,
      retentionDays: config.CHECK_RETENTION_DAYS,
      alerts,
      trigger: event && /^[a-z_]{1,40}$/.test(event) ? event : "manual",
      signal: controller.signal,
    });
    writeStepSummary(result);
    clearTimeout(hardKill);
    await disconnect();
    if (result.status === "truncated") say("::warning::Rodada truncada pelo teto de checagens; o restante será checado na próxima rodada.");
    process.exit(result.exitCode);
  } catch (err) {
    clearTimeout(hardKill);
    log.error({ err }, "worker failed");
    await disconnect();
    process.exit(EXIT.FAILED);
  }
}

main().catch((err) => {
  say(`Erro inesperado: ${safeError(err, secrets).message}`);
  process.exit(EXIT.FAILED);
});
