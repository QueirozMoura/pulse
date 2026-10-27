/**
 * Redação de segredos para qualquer texto que vá ao log ou ao resumo da execução.
 * Camadas: (1) valores conhecidos (DATABASE_URL inteira e a senha dela, chave do Resend); (2) credenciais em qualquer URL
 * (`esquema://usuario:senha@host`); (3) formato das chaves do Resend (`re_...`).
 */
const MIN_SECRET_LENGTH = 6; // evita "redigir" trechos curtos e comuns

export function secretsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const key of ["DATABASE_URL", "RESEND_API_KEY"]) {
    const v = env[key];
    if (!v) continue;
    out.push(v);
    if (key === "DATABASE_URL") {
      try {
        const u = new URL(v);
        if (u.password) out.push(u.password, decodeURIComponent(u.password));
        if (u.username) out.push(u.username);
      } catch {
        /* URL inválida: ainda vale o valor inteiro */
      }
    }
  }
  return out;
}

export function redactSecrets(text: string, secrets: string[] = []): string {
  let t = text;
  for (const s of [...new Set(secrets)].filter((x) => x.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length)) {
    t = t.split(s).join("[redigido]");
  }
  return t
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redigido]@")
    .replace(/\bre_[A-Za-z0-9_-]{10,}\b/g, "[redigido]");
}

export interface SafeError {
  name: string;
  code?: string;
  message: string;
}

/** Erro reduzido ao que é seguro registrar: nome, código e mensagem sem segredos (nunca stack nem `cause`). */
export function safeError(err: unknown, secrets: string[] = []): SafeError {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { name: err.name, ...(typeof code === "string" ? { code } : {}), message: redactSecrets(err.message, secrets).slice(0, 400) };
  }
  return { name: "NonError", message: redactSecrets(String(err), secrets).slice(0, 400) };
}
