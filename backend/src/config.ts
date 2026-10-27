import { z } from "zod";

const boolFromEnv = z
  .enum(["true", "false"])
  .transform((v) => v === "true");

const schema = z.object({
  // Padrão "production": se a variável faltar, o comportamento é o mais restritivo.
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().min(1),
  // --- Autenticação ---
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
  // "strict" exige frontend no mesmo site (ex.: app.exemplo.com + api.exemplo.com).
  // "none" é para frontend em outro site; exige produção (cookie Secure) e CORS_ALLOWED_ORIGIN.
  SESSION_COOKIE_SAMESITE: z.enum(["strict", "none"]).default("strict"),
  // Origem do frontend (ex.: https://app.exemplo.com). Ativa CORS com credenciais só para ela.
  CORS_ALLOWED_ORIGIN: z.url().optional(),
  // Quantos proxies confiáveis existem à frente (define req.ip a partir de X-Forwarded-For). 0 = nenhum.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  LOGIN_MAX_FAILURES_PER_IP: z.coerce.number().int().min(1).default(5),
  LOGIN_MAX_FAILURES_GLOBAL: z.coerce.number().int().min(1).default(30),
  SCHEDULER_ENABLED: boolFromEnv.default(true),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(100).default(5000),
  SCHEDULER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  CHECK_TIMEOUT_MS: z.coerce.number().int().min(500).max(60000).default(10000),
  MIN_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(30),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  const c = parsed.data;
  if (c.SESSION_COOKIE_SAMESITE === "none" && (c.NODE_ENV !== "production" || !c.CORS_ALLOWED_ORIGIN)) {
    throw new Error("SESSION_COOKIE_SAMESITE=none exige NODE_ENV=production e CORS_ALLOWED_ORIGIN.");
  }
  return parsed.data;
}
