/**
 * CLI de alertas.
 *
 *   npm run alerts -- status                 situação da outbox (contagens e últimas falhas); não envia nada
 *   npm run alerts -- test-send              simulação: mostra remetente/destino e NÃO envia
 *   npm run alerts -- test-send --confirm    envia UM e-mail de teste pelo Resend
 *
 * `test-send` usa sempre o provedor real e exige ALERT_DELIVERY=email, para nunca "parecer" que enviou em modo log.
 */
import { createResendTransport } from "../alerts/transports.js";
import { runTestSend } from "../alerts/test-send.js";
import { loadConfig } from "../config.js";
import { createDb } from "../lib/db.js";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "status" && command !== "test-send") {
    console.error("Uso: alerts status | alerts test-send [--confirm]");
    process.exit(2);
  }
  const config = loadConfig();

  if (command === "test-send") {
    if (config.ALERT_DELIVERY !== "email") {
      console.error("test-send exige ALERT_DELIVERY=email (com ALERT_EMAIL_TO, ALERT_EMAIL_FROM e RESEND_API_KEY).");
      process.exit(1);
    }
    const outcome = await runTestSend({
      transport: createResendTransport(config.RESEND_API_KEY!),
      to: config.ALERT_EMAIL_TO!,
      from: config.ALERT_EMAIL_FROM!,
      confirm: process.argv.includes("--confirm"),
      print: (l) => console.log(l),
    });
    process.exit(outcome === "failed" ? 1 : 0);
  }

  const db = createDb(config.DATABASE_URL);
  try {
    console.log(`Modo de entrega: ${config.ALERT_DELIVERY}`);
    const groups = await db.alertEvent.groupBy({ by: ["status"], _count: { _all: true } });
    for (const status of ["PENDING", "SENT", "FAILED"] as const) {
      console.log(`${status.padEnd(8)} ${groups.find((g) => g.status === status)?._count._all ?? 0}`);
    }
    const problems = await db.alertEvent.findMany({
      where: { OR: [{ status: "FAILED" }, { status: "PENDING", attempts: { gt: 0 } }] },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, kind: true, status: true, attempts: true, lastErrorKind: true, nextAttemptAt: true, createdAt: true },
    });
    if (problems.length > 0) {
      console.log("\nCom problema (mais recentes):");
      for (const p of problems) {
        console.log(`  ${p.id} ${p.kind} ${p.status} tentativas=${p.attempts} erro=${p.lastErrorKind ?? "-"} próxima=${p.nextAttemptAt.toISOString()}`);
      }
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error("Erro:", err instanceof Error ? err.message : err);
  process.exit(1);
});
