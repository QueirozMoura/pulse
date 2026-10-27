export type AlertKindName = "OPENED" | "RESOLVED";

/**
 * Tudo o que entra num e-mail de alerta. Propositalmente NÃO há campo de URL, host, cookie, token ou erro bruto:
 * o que não está neste tipo não tem como vazar para o e-mail.
 */
export interface AlertContent {
  kind: AlertKindName;
  monitorName: string;
  startedAt: Date;
  resolvedAt: Date | null;
  /** Categoria sanitizada da falha (timeout, dns, ...), nunca a mensagem. */
  errorKind: string | null;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const ERROR_KIND_LABEL: Record<string, string> = {
  timeout: "tempo esgotado (timeout)",
  dns: "falha de resolução de DNS",
  connection: "falha de conexão",
  tls: "falha de TLS/certificado",
  http_status: "resposta HTTP de erro (4xx/5xx)",
  redirect: "redirecionamento inválido",
  blocked: "destino bloqueado pelas proteções do Pulse",
  unknown: "falha não classificada",
};

const escapeHtml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Uma linha só, sem caracteres de controle (o nome é texto livre digitado pelo administrador). */
const oneLine = (v: string, max = 80) => v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim().slice(0, max);

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} s`;
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [d && `${d} d`, h && `${h} h`, m && `${m} min`, !d && !h && sec && `${sec} s`].filter(Boolean);
  return parts.join(" ");
}

const stamp = (d: Date) => `${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;

export function renderAlert(a: AlertContent): RenderedEmail {
  const name = oneLine(a.monitorName) || "(sem nome)";
  const cause = a.errorKind ? (ERROR_KIND_LABEL[a.errorKind] ?? ERROR_KIND_LABEL.unknown!) : null;

  if (a.kind === "OPENED") {
    const lines = [
      `O monitor "${name}" está INDISPONÍVEL.`,
      "",
      "Situação: incidente aberto após 2 falhas consecutivas.",
      `Início do incidente: ${stamp(a.startedAt)}`,
      ...(cause ? [`Tipo da falha: ${cause}`] : []),
      "",
      "Você receberá outro e-mail quando o serviço voltar ao normal. Nenhum novo alerta será enviado enquanto o incidente continuar aberto.",
    ];
    return build(`[Pulse] ALERTA: ${name} está indisponível`, lines);
  }

  const resolvedAt = a.resolvedAt ?? a.startedAt;
  const duration = formatDuration((resolvedAt.getTime() - a.startedAt.getTime()) / 1000);
  const lines = [
    `O monitor "${name}" voltou ao normal.`,
    "",
    "Situação: incidente resolvido.",
    `Início do incidente: ${stamp(a.startedAt)}`,
    `Fim do incidente: ${stamp(resolvedAt)}`,
    `Duração: ${duration}`,
    ...(cause ? [`Tipo da falha que originou o incidente: ${cause}`] : []),
  ];
  return build(`[Pulse] Resolvido: ${name} voltou ao normal (indisponível por ${duration})`, lines);
}

function build(subject: string, lines: string[]): RenderedEmail {
  const text = lines.join("\n");
  const html =
    `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111">` +
    lines.map((l) => (l === "" ? "<br>" : `<p style="margin:0 0 6px">${escapeHtml(l)}</p>`)).join("") +
    `</div>`;
  return { subject, text, html };
}
