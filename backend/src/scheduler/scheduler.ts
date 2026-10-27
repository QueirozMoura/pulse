import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../lib/db.js";
import { httpCheck } from "../checker/http-check.js";
import { recordCheck } from "../services/check-recorder.js";

export interface SchedulerOptions {
  tickMs: number;
  concurrency: number;
  timeoutMs: number;
}

interface DueMonitor {
  id: string;
  url: string;
}

/**
 * Loop independente da API. A cada tick, "reivindica" monitores vencidos com
 * UPDATE ... FOR UPDATE SKIP LOCKED, que já reagenda next_check_at na mesma
 * operação: duas instâncias nunca pegam o mesmo monitor e um restart apenas
 * retoma o que estiver vencido.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = new Set<Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
    private readonly opts: SchedulerOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    this.log.info({ tickMs: this.opts.tickMs }, "scheduler started");
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.inFlight]);
    this.log.info("scheduler stopped");
  }

  /** Um ciclo: reivindica monitores vencidos e checa. Exposto para testes. */
  async tick(): Promise<void> {
    if (this.running) return; // evita ciclos sobrepostos
    this.running = true;
    try {
      const due = await this.claimDue();
      await Promise.all(due.map((m) => this.track(this.checkOne(m))));
    } catch (err) {
      this.log.error({ err }, "scheduler tick failed");
    } finally {
      this.running = false;
    }
  }

  private claimDue(): Promise<DueMonitor[]> {
    return this.db.$queryRaw<DueMonitor[]>`
      UPDATE monitors
      SET next_check_at = (now() AT TIME ZONE 'UTC') + make_interval(secs => interval_seconds)
      WHERE id IN (
        SELECT id FROM monitors
        WHERE active AND next_check_at <= (now() AT TIME ZONE 'UTC')
        ORDER BY next_check_at
        LIMIT ${this.opts.concurrency}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, url`;
  }

  private track(p: Promise<void>): Promise<void> {
    this.inFlight.add(p);
    return p.finally(() => this.inFlight.delete(p));
  }

  private async checkOne(m: DueMonitor): Promise<void> {
    try {
      const outcome = await httpCheck(m.url, { timeoutMs: this.opts.timeoutMs });
      await recordCheck(this.db, m.id, outcome);
      this.log.info(
        { monitorId: m.id, success: outcome.success, statusCode: outcome.statusCode, latencyMs: outcome.latencyMs, errorKind: outcome.errorKind },
        "check completed",
      );
    } catch (err) {
      this.log.error({ err, monitorId: m.id }, "check failed to record");
    }
  }
}
