import type { FastifyBaseLogger } from "fastify";
import { httpCheck, type CheckOutcome } from "../checker/http-check.js";
import type { Db } from "../lib/db.js";
import { recordCheck } from "../services/check-recorder.js";
import { purgeOldChecks } from "../services/retention.js";

export interface SchedulerOptions {
  tickMs: number;
  /** Checagens simultâneas por instância. Uma vaga é reutilizada assim que a checagem termina. */
  concurrency: number;
  timeoutMs: number;
  retentionDays: number;
  /**
   * "Vencido" inclui o que vence nos próximos N segundos. Só o worker one-shot usa (padrão 0): como roda de tempos em
   * tempos, a rodada seguinte começa um pouco ANTES do vencimento e, sem folga, pularia o monitor até a rodada depois dela.
   */
  dueSlackSeconds?: number;
  /** Cria eventos de alerta ao abrir/resolver incidentes (ALERT_DELIVERY != off). */
  alertsEnabled?: boolean;
  /** Injetável para testes. */
  check?: (url: string) => Promise<CheckOutcome>;
}

interface DueMonitor {
  id: string;
  url: string;
}

const PURGE_EVERY_MS = 60 * 60_000;

export interface DrainOptions {
  /** Instante (epoch ms) depois do qual NÃO se reivindicam mais monitores. */
  deadlineMs: number;
  /** Instante depois do qual se desiste de esperar checagens em andamento. */
  hardDeadlineMs: number;
  /** Teto de monitores reivindicados nesta rodada. */
  maxChecks: number;
  signal?: AbortSignal;
}

export interface DrainResult {
  claimed: number;
  recorded: number;
  /** Gravadas só no histórico: já existia uma checagem mais nova. */
  stale: number;
  /** Monitor excluído, pausado ou com URL alterada durante a checagem. */
  discarded: number;
  /** Falhas ao gravar (banco). A checagem é perdida, nunca repetida. */
  errors: number;
  /** Parou por atingir maxChecks com monitores ainda vencidos. */
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
}

type CheckOutcomeKind = "recorded" | "recorded_stale" | "discarded" | "error";

/**
 * Loop independente da API. Garantias:
 * - Várias instâncias: `claimDue` usa UPDATE ... FOR UPDATE SKIP LOCKED e já reagenda next_check_at na
 *   mesma operação; dois processos nunca recebem o mesmo monitor (inclusive durante deploys com sobreposição).
 * - Restart: o agendamento está no banco. Monitores vencidos recebem UMA checagem (não uma por intervalo perdido).
 * - Checagem lenta: ocupa só a sua vaga. As demais continuam sendo reivindicadas; nada espera o mais lento.
 * - Falha de banco: o ciclo registra o erro e tenta de novo no próximo tick; o heartbeat sinaliza `stalled`.
 * - Queda no meio de uma checagem: o monitor já foi reagendado, então a checagem é perdida, nunca repetida
 *   (no máximo uma por intervalo; sem registros duplicados).
 */
export class Scheduler {
  private tickTimer: NodeJS.Timeout | null = null;
  private purgeTimer: NodeJS.Timeout | null = null;
  private claiming = false;
  private stopped = true;
  private lastClaimOkAt = 0;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly check: (url: string) => Promise<CheckOutcome>;
  private readonly slackSeconds: number;

  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
    private readonly opts: SchedulerOptions,
  ) {
    this.check = opts.check ?? ((url) => httpCheck(url, { timeoutMs: opts.timeoutMs }));
    this.slackSeconds = opts.dueSlackSeconds ?? 0;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.lastClaimOkAt = Date.now();
    this.log.info({ tickMs: this.opts.tickMs, concurrency: this.opts.concurrency }, "scheduler started");
    this.tickTimer = setInterval(() => void this.tick(), this.opts.tickMs);
    this.purgeTimer = setInterval(() => void this.purge(), PURGE_EVERY_MS);
    void this.tick();
    setTimeout(() => void this.purge(), 30_000).unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.tickTimer = this.purgeTimer = null;
    await Promise.allSettled([...this.inFlight]);
    this.log.info("scheduler stopped");
  }

  /** "stalled" se o banco não foi consultado com sucesso há tempo demais (ciclo travado ou banco fora). */
  status(): "ok" | "stalled" {
    return Date.now() - this.lastClaimOkAt > this.opts.tickMs * 3 + 15_000 ? "stalled" : "ok";
  }

  /** Reivindica monitores vencidos para as vagas livres e dispara as checagens (sem esperá-las). */
  async tick(): Promise<void> {
    if (this.claiming || this.stopped) return;
    const free = this.opts.concurrency - this.inFlight.size;
    if (free <= 0) return;
    this.claiming = true;
    try {
      const due = await this.claimDue(free);
      this.lastClaimOkAt = Date.now();
      for (const m of due) this.track(this.checkOne(m).then(() => undefined));
    } catch (err) {
      this.log.error({ err }, "scheduler tick failed");
    } finally {
      this.claiming = false;
    }
  }

  /** Resolve quando todas as checagens em andamento terminarem. Usado em testes e no shutdown. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  /** Há monitores vencidos que ainda não foram reivindicados? (sonda barata, sem reivindicar nada) */
  async hasDue(): Promise<boolean> {
    const rows = await this.db.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM monitors
      WHERE active AND next_check_at <= (now() AT TIME ZONE 'UTC') + make_interval(secs => ${this.slackSeconds}::double precision)
      LIMIT 1`;
    return rows.length > 0;
  }

  /**
   * Uma rodada limitada, SEM timers: reivindica monitores vencidos em lotes (as mesmas garantias de concorrência do
   * loop: UPDATE ... FOR UPDATE SKIP LOCKED que já reagenda), checa com `concurrency` vagas e devolve o balanço.
   * Duas execuções sobrepostas nunca checam o mesmo monitor. Para de reivindicar no prazo, no teto ou ao ser abortada,
   * e espera as checagens em andamento só até `hardDeadlineMs`.
   */
  async drain(o: DrainOptions): Promise<DrainResult> {
    const r: DrainResult = { claimed: 0, recorded: 0, stale: 0, discarded: 0, errors: 0, truncated: false, timedOut: false, aborted: false };
    const running = new Set<Promise<void>>();
    const launch = (m: DueMonitor) => {
      const p: Promise<void> = this.checkOne(m)
        .then((k) => void (k === "recorded" ? r.recorded++ : k === "recorded_stale" ? r.stale++ : k === "discarded" ? r.discarded++ : r.errors++))
        .finally(() => void running.delete(p));
      running.add(p);
    };

    try {
      for (;;) {
        if (o.signal?.aborted) { r.aborted = true; break; }
        if (Date.now() >= o.deadlineMs) { r.timedOut = true; break; }
        if (r.claimed >= o.maxChecks) { r.truncated = await this.hasDue(); break; }
        const free = this.opts.concurrency - running.size;
        if (free <= 0) { await Promise.race(running); continue; }
        const due = await this.claimDue(Math.min(free, o.maxChecks - r.claimed));
        if (due.length === 0) break; // nada mais vencido
        r.claimed += due.length;
        for (const m of due) launch(m);
      }
    } catch (err) {
      r.errors++;
      this.log.error({ err }, "drain: claim failed");
    }

    // Espera as checagens em andamento (cada uma tem o próprio timeout), mas não além do prazo duro.
    const wait = Math.max(0, o.hardDeadlineMs - Date.now());
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      Promise.allSettled([...running]).then(() => true),
      new Promise<boolean>((res) => { timer = setTimeout(() => res(false), wait); }),
    ]);
    clearTimeout(timer);
    if (!settled) r.timedOut = true; // o resultado dessas checagens se perde (at-most-once); o monitor já foi reagendado
    return r;
  }

  private claimDue(limit: number): Promise<DueMonitor[]> {
    return this.db.$queryRaw<DueMonitor[]>`
      UPDATE monitors
      SET next_check_at = (now() AT TIME ZONE 'UTC') + make_interval(secs => interval_seconds)
      WHERE id IN (
        SELECT id FROM monitors
        WHERE active AND next_check_at <= (now() AT TIME ZONE 'UTC') + make_interval(secs => ${this.slackSeconds}::double precision)
        ORDER BY next_check_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, url`;
  }

  private track(p: Promise<void>): void {
    this.inFlight.add(p);
    void p.finally(() => {
      this.inFlight.delete(p);
      void this.tick(); // vaga livre: já busca o próximo vencido
    });
  }

  private async checkOne(m: DueMonitor): Promise<CheckOutcomeKind> {
    const startedAt = new Date();
    try {
      const outcome = await this.check(m.url);
      const result = await recordCheck(this.db, m.id, outcome, { url: m.url, startedAt, alerts: this.opts.alertsEnabled ?? false });
      this.log.info(
        { monitorId: m.id, result, success: outcome.success, statusCode: outcome.statusCode, latencyMs: outcome.latencyMs, errorKind: outcome.errorKind },
        "check completed",
      );
      return result;
    } catch (err) {
      this.log.error({ err, monitorId: m.id }, "check failed to record");
      return "error";
    }
  }

  private async purge(): Promise<void> {
    if (this.stopped) return;
    try {
      const removed = await purgeOldChecks(this.db, this.opts.retentionDays);
      if (removed > 0) this.log.info({ removed, retentionDays: this.opts.retentionDays }, "old checks purged");
    } catch (err) {
      this.log.error({ err }, "retention purge failed");
    }
  }
}
