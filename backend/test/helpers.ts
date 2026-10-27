import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createAdminAccount } from "../src/auth/admin-account.js";
import { loadConfig } from "../src/config.js";
import { createDb, type Db } from "../src/lib/db.js";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL;
export const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

export const ADMIN_USER = "admin";
export const ADMIN_PASSWORD = "correct horse battery staple";

export interface Ctx {
  app: FastifyInstance;
  db: Db;
  close: () => Promise<void>;
}

export async function setup(env: Record<string, string> = {}): Promise<Ctx> {
  const db = createDb(TEST_DB_URL!);
  const config = loadConfig({
    DATABASE_URL: TEST_DB_URL!,
    NODE_ENV: "development",
    LOG_LEVEL: "silent",
    SCHEDULER_ENABLED: "false",
    ...env,
  });
  const app = buildApp(config, db);
  await app.ready();
  return {
    app,
    db,
    close: async () => {
      await app.close();
      await db.$disconnect();
    },
  };
}

export async function resetDb(db: Db): Promise<void> {
  await db.$executeRawUnsafe(
    "TRUNCATE admin_users, sessions, login_failures, monitors, check_results, incidents, worker_runs RESTART IDENTITY CASCADE",
  );
}

export const seedAdmin = (db: Db) => createAdminAccount(db, ADMIN_USER, ADMIN_PASSWORD);

export interface Login {
  cookie: string; // "nome=valor", pronto para o header Cookie
  token: string;
  csrf: string;
  setCookie: string;
}

export async function login(
  app: FastifyInstance,
  creds = { username: ADMIN_USER, password: ADMIN_PASSWORD },
  remoteAddress = "10.9.9.9",
): Promise<Login> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: creds, remoteAddress });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const setCookie = String(res.headers["set-cookie"]);
  const [pair] = setCookie.split(";");
  return { cookie: pair!, token: pair!.split("=")[1]!, csrf: res.json().csrfToken, setCookie };
}

export const authed = (l: Login, extra: Record<string, string> = {}) => ({ cookie: l.cookie, "x-csrf-token": l.csrf, ...extra });
export const validBody = { name: "Site", url: "https://example.com", intervalSeconds: 60 };

export async function mkMonitors(
  db: Db,
  n: number,
  over: { intervalSeconds?: number; nextCheckAt?: Date; active?: boolean; prefix?: string } = {},
) {
  const prefix = over.prefix ?? "m";
  await db.monitor.createMany({
    data: Array.from({ length: n }, (_, i) => ({
      name: `${prefix}${i}`,
      url: `https://${prefix}${i}.example.com/`,
      intervalSeconds: over.intervalSeconds ?? 60,
      nextCheckAt: over.nextCheckAt ?? new Date(Date.now() - 1000),
      active: over.active ?? true,
    })),
  });
  return db.monitor.findMany({ where: { name: { startsWith: prefix } }, orderBy: { name: "asc" } });
}

export const ok = { success: true, statusCode: 200, latencyMs: 20, errorKind: null } as const;
export const down = { success: false, statusCode: null, latencyMs: 20, errorKind: "dns" } as const;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(25);
  }
  throw new Error("waitFor: condição não atendida a tempo");
}
