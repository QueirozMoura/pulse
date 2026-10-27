import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../lib/db.js";
import { renderAlert } from "./email.js";
import type { EmailTransport, SendFailureKind } from "./transports.js";

export interface DispatcherOptions {
  transport: EmailTransport;
  to: string;
  from: string;
  tickMs?: number;
  /** Envios simultâneos por instância. */
  concurrency?: number;
  /** Quanto tempo uma instância "possui" um evento enquanto envia. Maior que o timeout do provedor. */
  leaseMs?: number;
  /** Tentativas totais (a primeira + retentativas). Esgotadas, o evento vira FAILED. */
  maxAttempts?: number;
  /** Espera antes da retentativa N (em segundos); a última entrada se repete. */
  backoffSeconds?: number[];
  maxPerHour?: number;
}

export const DEFAULT_BACKOFF_SECONDS = [60, 300, 900, 3600, 10_800, 21_600];
export const DEFAULT_MAX_ATTEMPTS = 7;

interface Claimed {
  id: string;
  attempts: number;
}

/**
 * Entrega os alertas da outbox (tabela alert_events). Roda num loop próprio, independente do scheduler de checagens:
 * um provedor lento ou fora do ar nunca atrasa uma checagem.
 *
 * Garantias:
 * - Sem duplicidade entre instâncias: `claim` usa FOR UPDATE SKIP LOCKED + lease; e o id do evento vai como
 *   Idempotency-Key ao provedor, que descarta reenvios (janela de 24 h no Resend) caso o processo caia
 *   depois do envio e antes de registrar o resultado.
 * - Sem perda: a linha existe antes de qualquer envio; se o processo morrer, o lease expira e outra instância continua.
 * - Retentativas com limite e espera crescente; o resultado (tentativas, categoria do erro, horário) fica na linha.
 * - Um "resolvido" só sai depois que o "aberto" do mesmo incidente terminou (enviado ou esgotado): a ordem faz sentido.
 * - Teto por hora: um monitor oscilando não esgota a cota do provedor; o excedente espera, não se perde.
 */
export class AlertDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false; // só vira true depois de stop(); tick() funciona mesmo sem start() (testes, execução pontual)
  private claiming = false;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly o: Required<Omit<DispatcherOptions, "transport" | "to" | "from">>;

  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
    private readonly opts: DispatcherOptions,
  ) {
    this.o = {
      tickMs: opts.tickMs ?? 10_000,
      concurrency: opts.concurrency ?? 3,
      leaseMs: opts.leaseMs ?? 120_000,
      maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      backoffSeconds: opts.backoffSeconds ?? DEFAULT_BACKOFF_SECONDS,
      maxPerHour: opts.maxPerHour ?? 30,
    };
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.log.info({ tickMs: this.o.tickMs, maxPerHour: this.o.maxPerHour }, "alert dispatcher started");
    this.timer = setInterval(() => void this.tick(), this.o.tickMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.idle();
    this.log.info("alert dispatcher stopped");
  }

  /** Resolve quando não há envio em andamento nem reivindicação em curso (que poderia iniciar um). */
  async idle(): Promise<void> {
    while (this.claiming || this.inFlight.size > 0) {
      if (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
      else await new Promise((r) => setTimeout(r, 5));
    }
  }

  async tick(): Promise<void> {
    if (this.claiming || this.stopped) return;
    this.claiming = true;
    try {
      const sentLastHour = await this.db.alertEvent.count({
        where: { status: "SENT", sentAt: { gte: new Date(Date.now() - 3_600_000) } },
      });
      const limit = Math.min(this.o.concurrency - this.inFlight.size, this.o.maxPerHour - sentLastHour - this.inFlight.size);
      if (limit <= 0) return;
      for (const c of await this.claim(limit)) this.track(this.deliver(c));
    } catch (err) {
      this.log.error({ err }, "alert dispatcher tick failed");
    } finally {
      this.claiming = false;
    }
  }

  private claim(limit: number): Promise<Claimed[]> {
    const leaseSeconds = this.o.leaseMs / 1000;
    return this.db.$queryRaw<Claimed[]>`
      UPDATE alert_events
      SET attempts = attempts + 1,
          last_attempt_at = (now() AT TIME ZONE 'UTC'),
          locked_until = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${leaseSeconds}::double precision)
      WHERE id IN (
        SELECT e.id FROM alert_events e
        WHERE e.status = 'PENDING'
          AND e.next_attempt_at <= (now() AT TIME ZONE 'UTC')
          AND (e.locked_until IS NULL OR e.locked_until <= (now() AT TIME ZONE 'UTC'))
          AND (e.kind = 'OPENED' OR NOT EXISTS (
                SELECT 1 FROM alert_events o
                WHERE o.incident_id = e.incident_id AND o.kind = 'OPENED' AND o.status = 'PENDING'))
        ORDER BY e.created_at
        LIMIT ${limit}
        FOR UPDATE OF e SKIP LOCKED
      )
      RETURNING id, attempts`;
  }

  private track(p: Promise<void>): void {
    this.inFlight.add(p);
    void p.finally(() => {
      this.inFlight.delete(p);
      void this.tick();
    });
  }

  private async deliver({ id, attempts }: Claimed): Promise<void> {
    try {
      const event = await this.db.alertEvent.findUnique({
        where: { id },
        select: {
          kind: true,
          incident: { select: { monitorId: true, startedAt: true, resolvedAt: true, monitor: { select: { name: true } } } },
        },
      });
      if (!event) return; // incidente/monitor excluído: o alerta perdeu o sentido

      const cause = await this.db.checkResult.findFirst({
        where: { monitorId: event.incident.monitorId, success: false, checkedAt: { lte: event.incident.startedAt } },
        orderBy: { checkedAt: "desc" },
        select: { errorKind: true },
      });
      // Só estes campos chegam ao e-mail: nome, horários e a categoria da falha. Nunca a URL do monitor.
      const email = renderAlert({
        kind: event.kind,
        monitorName: event.incident.monitor.name,
        startedAt: event.incident.startedAt,
        resolvedAt: event.incident.resolvedAt,
        errorKind: cause?.errorKind ?? null,
      });

      let result;
      try {
        result = await this.opts.transport.send({ to: this.opts.to, from: this.opts.from, ...email, idempotencyKey: `pulse-alert-${id}` });
      } catch {
        result = { ok: false as const, kind: "unknown" as SendFailureKind }; // transporte com bug: trata como falha, sem vazar a mensagem
      }

      if (result.ok) {
        await this.db.alertEvent.updateMany({
          where: { id, status: "PENDING" },
          data: { status: "SENT", sentAt: new Date(), providerMessageId: result.messageId, lockedUntil: null, lastErrorKind: null },
        });
        this.log.info({ alertEventId: id, kind: event.kind, attempts }, "alert sent");
        return;
      }
      await this.recordFailure(id, event.kind, attempts, result.kind, result.httpStatus);
    } catch (err) {
      // Ex.: o provedor aceitou o e-mail mas o banco falhou ao registrar. O lease expira e o evento será
      // reenviado com a MESMA Idempotency-Key, então o provedor não entrega duas vezes.
      this.log.error({ err, alertEventId: id }, "alert delivery bookkeeping failed");
    }
  }

  private async recordFailure(id: string, kind: string, attempts: number, errorKind: SendFailureKind, httpStatus?: number): Promise<void> {
    if (attempts >= this.o.maxAttempts) {
      await this.db.alertEvent.updateMany({ where: { id, status: "PENDING" }, data: { status: "FAILED", lockedUntil: null, lastErrorKind: errorKind } });
      this.log.error({ alertEventId: id, kind, attempts, errorKind, httpStatus }, "alert permanently failed (retry limit reached)");
      return;
    }
    const wait = this.o.backoffSeconds[Math.min(attempts - 1, this.o.backoffSeconds.length - 1)] ?? 60;
    await this.db.$executeRaw`
      UPDATE alert_events
      SET locked_until = NULL,
          last_error_kind = ${errorKind},
          next_attempt_at = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${wait}::double precision)
      WHERE id = ${id}::uuid AND status = 'PENDING'`;
    this.log.warn({ alertEventId: id, kind, attempts, errorKind, httpStatus, retryInSeconds: wait }, "alert delivery failed, will retry");
  }
}
