const nf = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const timeOnly = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const formatDateTime = (iso: string | number | Date) => dateTime.format(new Date(iso));
export const formatTime = (iso: string | number | Date) => timeOnly.format(new Date(iso));

/** "há 12 s", "há 5 min", "há 3 h", "há 2 d". `seconds` negativo (relógio adiantado) vira "agora". */
export function formatAgo(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 10) return "agora mesmo";
  if (s < 60) return `há ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} d`;
}

/** Duração legível, igual à do e-mail de alerta: "1 min 2 s", "2 h 5 min". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} s`;
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [d && `${d} d`, h && `${h} h`, m && `${m} min`, !d && !h && sec && `${sec} s`].filter(Boolean).join(" ");
}

export function formatLatency(ms: number): string {
  return ms >= 1000 ? `${nf.format(ms / 1000)} s` : `${Math.round(ms)} ms`;
}

/** Percentual com duas casas no máximo; null (sem checagens) nunca vira número. */
export function formatPercent(p: number | null): string {
  return p === null ? "Sem dados" : `${nf.format(p)}%`;
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const ERROR_KIND: Record<string, string> = {
  timeout: "Tempo esgotado",
  dns: "Falha de DNS",
  connection: "Falha de conexão",
  tls: "Falha de TLS/certificado",
  http_status: "Resposta HTTP de erro",
  redirect: "Redirecionamento inválido",
  blocked: "Destino bloqueado",
  unknown: "Falha não classificada",
};
export const errorKindLabel = (k: string | null) => (k ? (ERROR_KIND[k] ?? ERROR_KIND.unknown!) : "");
