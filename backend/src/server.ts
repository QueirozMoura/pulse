import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./lib/db.js";
import { Scheduler } from "./scheduler/scheduler.js";

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const app = buildApp(config, db);

const scheduler = config.SCHEDULER_ENABLED
  ? new Scheduler(db, app.log, {
      tickMs: config.SCHEDULER_TICK_MS,
      concurrency: config.SCHEDULER_CONCURRENCY,
      timeoutMs: config.CHECK_TIMEOUT_MS,
    })
  : null;

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  try {
    await scheduler?.stop();
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
} catch (err) {
  app.log.error({ err }, "failed to start");
  process.exit(1);
}
