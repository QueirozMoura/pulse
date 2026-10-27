import type { Db } from "../lib/db.js";
import type { CheckOutcome } from "../checker/http-check.js";
import { nextTransition } from "../domain/transitions.js";

export interface CheckContext {
  /** URL que foi de fato checada (o monitor pode ter sido editado enquanto a checagem corria). */
  url: string;
  /** Quando a checagem COMEÇOU. É o horário gravado no histórico. */
  startedAt: Date;
  /** Cria o evento de alerta (outbox) na mesma transação que abre/resolve o incidente. */
  alerts?: boolean;
}

export type RecordResult =
  | "recorded" // aplicada: histórico + estado + incidente
  | "recorded_stale" // histórico gravado, mas estado intocado: já existe uma checagem mais nova
  | "discarded"; // monitor excluído, pausado ou com outra URL: o resultado não vale mais

/**
 * Persiste o resultado de uma checagem e aplica a transição de estado
 * (incluindo abrir/resolver incidente) numa única transação.
 *
 * Proteções contra resultados atrasados:
 * - a linha do monitor é travada (FOR UPDATE): checagens concorrentes do mesmo monitor se serializam;
 * - resultado de monitor excluído/pausado/editado durante a checagem é descartado;
 * - resultado mais antigo que a última checagem aplicada entra no histórico, mas não mexe no estado
 *   (um sucesso velho não resolve um incidente novo, uma falha velha não conta como "consecutiva").
 */
export async function recordCheck(db: Db, monitorId: string, outcome: CheckOutcome, ctx: CheckContext): Promise<RecordResult> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM monitors WHERE id = ${monitorId}::uuid FOR UPDATE`;

    const monitor = await tx.monitor.findUnique({ where: { id: monitorId } });
    if (!monitor || !monitor.active || monitor.url !== ctx.url) return "discarded";

    await tx.checkResult.create({
      data: {
        monitorId,
        checkedAt: ctx.startedAt,
        success: outcome.success,
        statusCode: outcome.statusCode,
        latencyMs: outcome.latencyMs,
        errorKind: outcome.errorKind,
      },
    });

    if (monitor.lastCheckedAt && ctx.startedAt <= monitor.lastCheckedAt) return "recorded_stale";

    const openIncident = await tx.incident.findFirst({
      where: { monitorId, resolvedAt: null },
      select: { id: true },
    });

    const t = nextTransition(
      { status: monitor.status, consecutiveFailures: monitor.consecutiveFailures, hasOpenIncident: openIncident !== null },
      outcome.success,
    );

    await tx.monitor.update({
      where: { id: monitorId },
      data: { status: t.status, consecutiveFailures: t.consecutiveFailures, lastCheckedAt: ctx.startedAt },
    });

    // Os eventos de alerta nascem junto da transição e na mesma transação: não existe incidente aberto/resolvido
    // sem o seu evento, e o evento sobrevive a restart e a falha do provedor. Só as TRANSIÇÕES geram evento:
    // falhas seguintes com o incidente já aberto não geram nada. skipDuplicates + UNIQUE(incidente, tipo) são rede de segurança.
    if (t.incident === "open") {
      const incident = await tx.incident.create({ data: { monitorId, startedAt: ctx.startedAt } });
      if (ctx.alerts) await tx.alertEvent.createMany({ data: [{ incidentId: incident.id, kind: "OPENED" }], skipDuplicates: true });
    } else if (t.incident === "resolve" && openIncident) {
      await tx.incident.update({ where: { id: openIncident.id }, data: { resolvedAt: ctx.startedAt } });
      if (ctx.alerts) await tx.alertEvent.createMany({ data: [{ incidentId: openIncident.id, kind: "RESOLVED" }], skipDuplicates: true });
    }
    return "recorded";
  });
}
