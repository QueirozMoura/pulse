import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./lib/db.js";
import { AlertDispatcher } from "./alerts/dispatcher.js";
import { createLogTransport, createResendTransport } from "./alerts/transports.js";
import { Scheduler } from "./scheduler/scheduler.js";

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
let scheduler: Scheduler | null = null;
const app = buildApp(config, db, { schedulerStatus: () => (scheduler ? scheduler.status() : "disabled") });

if (config.SCHEDULER_ENABLED) {
  scheduler = new Scheduler(db, app.log, {
    tickMs: config.SCHEDULER_TICK_MS,
    concurrency: config.SCHEDULER_CONCURRENCY,
    timeoutMs: config.CHECK_TIMEOUT_MS,
    retentionDays: config.CHECK_RETENTION_DAYS,
    alertsEnabled: config.ALERT_DELIVERY !== "off",
  });
}

// O dispatcher roda onde roda o scheduler (é ele quem cria os eventos). Em modo "log" nada sai da máquina.
let dispatcher: AlertDispatcher | null = null;
if (config.SCHEDULER_ENABLED && config.ALERT_DELIVERY !== "off") {
  dispatcher = new AlertDispatcher(db, app.log, {
    transport: config.ALERT_DELIVERY === "email" ? createResendTransport(config.RESEND_API_KEY!) : createLogTransport(app.log),
    to: config.ALERT_EMAIL_TO ?? "dev@localhost",
    from: config.ALERT_EMAIL_FROM ?? "Pulse <pulse@localhost>",
    maxPerHour: config.ALERT_MAX_PER_HOUR,
  });
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  try {
    await scheduler?.stop();
    await dispatcher?.stop();
    await app.close();
    await db.$disconnect();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "error during shutdown");
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
  scheduler?.start();
  dispatcher?.start();
} catch (err) {
  app.log.error({ err }, "failed to start");
  process.exit(1);
}
