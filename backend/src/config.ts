import { z } from "zod";

const boolFromEnv = z
  .enum(["true", "false"])
  .transform((v) => v === "true");

// Remetente simples ou "Nome <endereço>"; sem CR/LF (injeção de cabeçalho).
const EMAIL_FROM = /^(?:[^<>\r\n]{1,100} <)?[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+>?$/;

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
  // --- Alertas por e-mail ---
  // off  = nada é criado nem enviado (padrão, inclusive em desenvolvimento)
  // log  = a outbox funciona e o e-mail renderizado vai só para o log (sem rede): ideal para desenvolvimento
  // email = envia de verdade pelo Resend
  ALERT_DELIVERY: z.enum(["off", "log", "email"]).default("off"),
  ALERT_EMAIL_TO: z.email().optional(),
  ALERT_EMAIL_FROM: z.string().regex(EMAIL_FROM, "use 'alertas@dominio.com' ou 'Pulse <alertas@dominio.com>'").optional(),
  RESEND_API_KEY: z.string().min(10).max(200).optional(),
  // Teto de e-mails enviados por hora: um monitor oscilando não esgota a cota do provedor. O excedente espera, não se perde.
  ALERT_MAX_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(30),
  // --- Worker one-shot (GitHub Actions, plano gratuito) ---
  // Tempo total da execução. Passado disso o worker encerra de forma graciosa e, em último caso, é derrubado (exit 3).
  WORKER_TIMEOUT_SECONDS: z.coerce.number().int().min(60).max(1500).default(240),
  // Teto de checagens por execução. O que sobrar continua vencido e é pego pela próxima rodada.
  WORKER_MAX_CHECKS: z.coerce.number().int().min(1).max(2000).default(200),
  // O worker roda de tempos em tempos, então "vencido" inclui o que vence nos próximos N segundos.
  // Sem isto, um monitor de 15 min seria pulado metade das rodadas (a rodada seguinte começa um pouco antes do vencimento).
  WORKER_DUE_SLACK_SECONDS: z.coerce.number().int().min(0).max(1800).default(300),
  // Cadência esperada das rodadas. Se definida, o /health e a API pública informam a última rodada e o atraso real.
  WORKER_EXPECTED_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).optional(),
  // Depois de quantos minutos sem rodada bem-sucedida o worker é considerado atrasado (padrão: 3 × a cadência).
  WORKER_LATE_AFTER_MINUTES: z.coerce.number().int().min(5).max(10080).optional(),
  // Guarda respostas públicas em memória por N segundos: menos consultas ao banco (no Neon gratuito, cada consulta
  // acorda a computação). 0 = desligado. Mudanças feitas no painel limpam o cache na hora.
  PUBLIC_CACHE_SECONDS: z.coerce.number().int().min(0).max(3600).default(0),
  // Pasta com o build do frontend (ex.: ../frontend/dist) para a API servir o painel na MESMA origem da API.
  STATIC_DIR: z.string().min(1).optional(),
  SCHEDULER_ENABLED: boolFromEnv.default(true),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(100).default(5000),
  SCHEDULER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  CHECK_TIMEOUT_MS: z.coerce.number().int().min(500).max(60000).default(10000),
  MIN_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(30),
  // Teto de monitores cadastrados (limita o tamanho das listas e o volume de checagens).
  MAX_MONITORS: z.coerce.number().int().min(1).max(1000).default(100),
  // Checagens mais antigas que isso são apagadas. Mínimo 7 dias: a janela de uptime mais longa da API pública.
  CHECK_RETENTION_DAYS: z.coerce.number().int().min(7).max(365).default(30),
});

export type Config = z.infer<typeof schema>;

/** Variável vazia ("") é tratada como ausente: segredos não definidos no GitHub Actions chegam como string vazia. */
const withoutEmpty = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));

/** Intervalo mínimo aceito num monitor: o configurado, mas sempre maior que o timeout da checagem. */
export function effectiveMinIntervalSeconds(c: Pick<Config, "MIN_INTERVAL_SECONDS" | "CHECK_TIMEOUT_MS">): number {
  return Math.max(c.MIN_INTERVAL_SECONDS, Math.floor(c.CHECK_TIMEOUT_MS / 1000) + 1);
}

export function workerLateAfterMinutes(c: Pick<Config, "WORKER_EXPECTED_INTERVAL_MINUTES" | "WORKER_LATE_AFTER_MINUTES">): number | null {
  if (c.WORKER_LATE_AFTER_MINUTES) return c.WORKER_LATE_AFTER_MINUTES;
  return c.WORKER_EXPECTED_INTERVAL_MINUTES ? c.WORKER_EXPECTED_INTERVAL_MINUTES * 3 : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(withoutEmpty(env));
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  const c = parsed.data;
  if (c.ALERT_DELIVERY === "email") {
    const missing = (["ALERT_EMAIL_TO", "ALERT_EMAIL_FROM", "RESEND_API_KEY"] as const).filter((k) => !c[k]);
    if (missing.length > 0) throw new Error(`ALERT_DELIVERY=email exige: ${missing.join(", ")}.`);
  }
  // Folga para o worker fechar com elegância: as checagens em andamento (até CHECK_TIMEOUT_MS) + gravação + desconexão.
  if (c.WORKER_TIMEOUT_SECONDS * 1000 < c.CHECK_TIMEOUT_MS + 45_000) {
    throw new Error("WORKER_TIMEOUT_SECONDS precisa ser pelo menos CHECK_TIMEOUT_MS + 45 s (folga para encerrar com elegância).");
  }
  if (c.SESSION_COOKIE_SAMESITE === "none" && (c.NODE_ENV !== "production" || !c.CORS_ALLOWED_ORIGIN)) {
    throw new Error("SESSION_COOKIE_SAMESITE=none exige NODE_ENV=production e CORS_ALLOWED_ORIGIN.");
  }
  return parsed.data;
}
