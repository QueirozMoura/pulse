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
  // Rotas de gerenciamento (POST/GET /monitors). Sem autenticação ainda: só podem existir fora de produção.
  ADMIN_ROUTES_ENABLED: boolFromEnv.default(false),
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
  if (parsed.data.NODE_ENV === "production" && parsed.data.ADMIN_ROUTES_ENABLED) {
    throw new Error(
      "ADMIN_ROUTES_ENABLED=true é proibido com NODE_ENV=production: as rotas de escrita não têm autenticação.",
    );
  }
  return parsed.data;
}
