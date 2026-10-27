import type { Db } from "../lib/db.js";
import type { CheckOutcome } from "../checker/http-check.js";
import { nextTransition } from "../domain/transitions.js";

/**
 * Persiste o resultado de uma checagem e aplica a transição de estado
 * (incluindo abrir/resolver incidente) numa única transação.
 */
export async function recordCheck(db: Db, monitorId: string, outcome: CheckOutcome): Promise<void> {
  await db.$transaction(async (tx) => {
    // Trava a linha do monitor para serializar checagens concorrentes do mesmo monitor.
    await tx.$queryRaw`SELECT id FROM monitors WHERE id = ${monitorId}::uuid FOR UPDATE`;

    const monitor = await tx.monitor.findUnique({ where: { id: monitorId } });
    if (!monitor) return; // removido durante a checagem

    const openIncident = await tx.incident.findFirst({
      where: { monitorId, resolvedAt: null },
      select: { id: true },
    });

    const t = nextTransition(
      {
        status: monitor.status,
        consecutiveFailures: monitor.consecutiveFailures,
        hasOpenIncident: openIncident !== null,
      },
      outcome.success,
    );

    const now = new Date();
    await tx.checkResult.create({
      data: {
        monitorId,
        checkedAt: now,
        success: outcome.success,
        statusCode: outcome.statusCode,
        latencyMs: outcome.latencyMs,
        errorKind: outcome.errorKind,
      },
    });
    await tx.monitor.update({
      where: { id: monitorId },
      data: { status: t.status, consecutiveFailures: t.consecutiveFailures, lastCheckedAt: now },
    });

    if (t.incident === "open") {
      await tx.incident.create({ data: { monitorId, startedAt: now } });
    } else if (t.incident === "resolve" && openIncident) {
      await tx.incident.update({ where: { id: openIncident.id }, data: { resolvedAt: now } });
    }
  });
}
