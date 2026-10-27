import type { FastifyBaseLogger } from "fastify";
import { AlertDispatcher, type AlertDrainResult } from "../alerts/dispatcher.js";
import type { EmailTransport } from "../alerts/transports.js";
import type { CheckOutcome } from "../checker/http-check.js";
import type { Db } from "../lib/db.js";
import { Scheduler, type DrainResult } from "../scheduler/scheduler.js";
import { purgeOldChecks } from "../services/retention.js";

export type RunStatus = "ok" | "truncated" | "failed" | "timeout" | "cancelled";

/** Códigos de saída: o GitHub Actions marca a execução como falha em qualquer valor diferente de 0. */
export const EXIT = { OK: 0, FAILED: 1, BAD_CONFIG: 2, TIMEOUT: 3, CANCELLED: 130 } as const;

export interface WorkerAlerts {
  transport: EmailTransport;
  to: string;
  from: string;
  maxPerHour: number;
  concurrency?: number;
  maxAttempts?: number;
  backoffSeconds?: number[];
  leaseMs?: number;
}

export interface WorkerOptions {
  /** Tempo total da execução. */
  timeoutMs: number;
  maxChecks: number;
  concurrency: number;
  checkTimeoutMs: number;
  dueSlackSeconds: number;
  retentionDays: number;
  /** null = alertas desligados (nada é criado nem enviado). */
  alerts: WorkerAlerts | null;
  trigger?: string | null;
  signal?: AbortSignal;
  /** Injetável para testes. */
  check?: (url: string) => Promise<CheckOutcome>;
}

export interface WorkerResult {
  runId: string;
  status: RunStatus;
  exitCode: (typeof EXIT)[keyof typeof EXIT];
  durationMs: number;
  checks: DrainResult | null;
  alerts: AlertDrainResult | null;
  errors: number;
}

const RUN_HISTORY_DAYS = 14;

/**
 * Uma rodada completa do worker: checagens vencidas → alertas pendentes → faxina → batimento.
 *
 * Não roda migrations, não cria administrador e não mantém nenhum loop. Seguro para execuções sobrepostas
 * (agendada + manual): monitores e eventos de alerta são reivindicados com SKIP LOCKED, então nada é checado
 * nem enviado duas vezes; executar de novo logo em seguida simplesmente não acha nada vencido.
 *
 * Prazos (a partir do início, T = timeoutMs): para de reivindicar monitores cedo o bastante para as checagens em andamento
 * terminarem e sobrar uma reserva para os alertas; os alertas têm o próprio prazo; o final fica com uma margem para gravar o
 * resultado e desconectar. Ao ser abortado (SIGTERM do GitHub), para de reivindicar e fecha o que já está em andamento.
 */
export async function runWorkerOnce(db: Db, log: FastifyBaseLogger, o: WorkerOptions): Promise<WorkerResult> {
  const start = Date.now();
  const margin = Math.min(10_000, o.timeoutMs * 0.05);
  const alertsReserve = o.alerts ? Math.min(25_000, o.timeoutMs * 0.1) : 0;
  const hardEnd = start + o.timeoutMs - margin;

  // Execuções mortas à força (SIGKILL) ficam "running" para sempre: marca-as para não poluir o histórico.
  await db.workerRun.updateMany({
    where: { status: "running", startedAt: { lt: new Date(start - o.timeoutMs - 120_000) } },
    data: { status: "abandoned", finishedAt: new Date() },
  });
  const run = await db.workerRun.create({ data: { trigger: o.trigger ?? null }, select: { id: true } });
  log.info({ runId: run.id, trigger: o.trigger ?? null }, "worker run started");

  let errors = 0;
  let checks: DrainResult | null = null;
  let alerts: AlertDrainResult | null = null;

  try {
    const scheduler = new Scheduler(db, log, {
      tickMs: 1000, // não usado: o worker não tem loop
      concurrency: o.concurrency,
      timeoutMs: o.checkTimeoutMs,
      retentionDays: o.retentionDays,
      dueSlackSeconds: o.dueSlackSeconds,
      alertsEnabled: o.alerts !== null,
      check: o.check,
    });
    checks = await scheduler.drain({
      deadlineMs: hardEnd - alertsReserve - o.checkTimeoutMs,
      hardDeadlineMs: hardEnd - alertsReserve,
      maxChecks: o.maxChecks,
      signal: o.signal,
    });
    errors += checks.errors;
  } catch (err) {
    errors++;
    log.error({ err }, "check phase crashed");
  }

  if (o.alerts) {
    try {
      const dispatcher = new AlertDispatcher(db, log, {
        transport: o.alerts.transport,
        to: o.alerts.to,
        from: o.alerts.from,
        maxPerHour: o.alerts.maxPerHour,
        concurrency: o.alerts.concurrency ?? 3,
        maxAttempts: o.alerts.maxAttempts,
        backoffSeconds: o.alerts.backoffSeconds,
        leaseMs: o.alerts.leaseMs,
      });
      alerts = await dispatcher.drain({ deadlineMs: hardEnd - Math.min(5_000, o.timeoutMs * 0.02), hardDeadlineMs: hardEnd, signal: o.signal });
      errors += alerts.errors;
    } catch (err) {
      errors++;
      log.error({ err }, "alert phase crashed");
    }
  }

  const aborted = Boolean(checks?.aborted || alerts?.aborted || o.signal?.aborted);
  const timedOut = Boolean(checks?.timedOut || alerts?.timedOut);

  // Faxina barata, só se sobrar tempo: retenção do histórico (em lotes), runs antigas, sessões e falhas de login vencidas.
  if (!aborted && !timedOut && Date.now() < hardEnd - 3_000) {
    try {
      await purgeOldChecks(db, o.retentionDays, 5000, 4);
      await db.workerRun.deleteMany({ where: { startedAt: { lt: new Date(Date.now() - RUN_HISTORY_DAYS * 86_400_000) } } });
      await db.session.deleteMany({ where: { expiresAt: { lte: new Date() } } });
      await db.loginFailure.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 86_400_000) } } });
    } catch (err) {
      log.warn({ err }, "housekeeping failed (non-fatal)");
    }
  }

  let status: RunStatus = "ok";
  if (aborted) status = "cancelled";
  else if (timedOut) status = "timeout";
  else if (errors > 0) status = "failed";
  else if (checks?.truncated) status = "truncated";
  let exitCode: WorkerResult["exitCode"] = status === "ok" || status === "truncated" ? EXIT.OK : status === "failed" ? EXIT.FAILED : status === "timeout" ? EXIT.TIMEOUT : EXIT.CANCELLED;

  try {
    await db.workerRun.update({
      where: { id: run.id },
      data: {
        status,
        finishedAt: new Date(),
        checksClaimed: checks?.claimed ?? 0,
        checksRecorded: (checks?.recorded ?? 0) + (checks?.stale ?? 0),
        alertsSent: alerts?.sent ?? 0,
        alertsRetried: alerts?.retried ?? 0,
        alertsFailed: alerts?.failed ?? 0,
        errors,
      },
    });
  } catch (err) {
    // Sem gravar o batimento o /health continuará mostrando atraso: isso precisa aparecer como falha da execução.
    log.error({ err }, "could not record worker run result");
    if (exitCode === EXIT.OK) exitCode = EXIT.FAILED;
    status = "failed";
  }

  const result: WorkerResult = { runId: run.id, status, exitCode, durationMs: Date.now() - start, checks, alerts, errors };
  log.info({ runId: run.id, status, exitCode, durationMs: result.durationMs, checks, alerts, errors }, "worker run finished");
  return result;
}
