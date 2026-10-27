import type { Db } from "../lib/db.js";

export type WorkerStatus = "ok" | "late" | "never" | "unknown";

export interface WorkerHealth {
  status: WorkerStatus;
  /** Fim da última rodada bem-sucedida (ok ou truncada). null = nenhuma ainda. */
  lastSuccessAt: string | null;
  ageSeconds: number | null;
  expectedEveryMinutes: number;
  lateAfterMinutes: number;
  /** A última execução, qualquer que seja o resultado (mostra falhas recentes e uma execução em andamento). */
  lastRun: { status: string; startedAt: string; finishedAt: string | null } | null;
}

/**
 * Saúde do worker a partir do batimento no banco. É informativa: o HTTP de /health NUNCA depende dela, para que um
 * agendamento atrasado do GitHub não faça a hospedagem reiniciar a API.
 */
export async function workerHealth(db: Db, cfg: { expectedEveryMinutes: number; lateAfterMinutes: number }, nowMs = Date.now()): Promise<WorkerHealth> {
  const base = { expectedEveryMinutes: cfg.expectedEveryMinutes, lateAfterMinutes: cfg.lateAfterMinutes };
  try {
    const [ok, last] = await Promise.all([
      db.workerRun.findFirst({ where: { status: { in: ["ok", "truncated"] }, finishedAt: { not: null } }, orderBy: { finishedAt: "desc" }, select: { finishedAt: true } }),
      db.workerRun.findFirst({ orderBy: { startedAt: "desc" }, select: { status: true, startedAt: true, finishedAt: true } }),
    ]);
    const lastRun = last ? { status: last.status, startedAt: last.startedAt.toISOString(), finishedAt: last.finishedAt?.toISOString() ?? null } : null;
    if (!ok?.finishedAt) return { ...base, status: "never", lastSuccessAt: null, ageSeconds: null, lastRun };
    const ageSeconds = Math.max(0, Math.round((nowMs - ok.finishedAt.getTime()) / 1000));
    return { ...base, status: ageSeconds > cfg.lateAfterMinutes * 60 ? "late" : "ok", lastSuccessAt: ok.finishedAt.toISOString(), ageSeconds, lastRun };
  } catch {
    // Ex.: a migration ainda não foi aplicada. Não derruba o /health; diz que não sabe.
    return { ...base, status: "unknown", lastSuccessAt: null, ageSeconds: null, lastRun: null };
  }
}
