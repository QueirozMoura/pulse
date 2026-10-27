import type { PublicMonitor } from "../api/types";

/** Intervalo entre atualizações da página pública. A resposta da API é cacheável por 10 s. */
export const POLL_MS = 30_000;
/** Depois de quantas atualizações perdidas os dados em tela são considerados desatualizados. */
export const STALE_AFTER_POLLS = 3;

export const isFetchStale = (lastSuccessLocalMs: number | null, nowLocalMs: number, pollMs = POLL_MS): boolean =>
  lastSuccessLocalMs === null || nowLocalMs - lastSuccessLocalMs > pollMs * STALE_AFTER_POLLS;

/**
 * A API pública NÃO expõe o intervalo de checagem (de propósito). Estimamos a cadência a partir da amostra de 24 h:
 * janela observada ÷ número de checagens. Pausas e quedas do Pulse só esticam a estimativa (deixam o teste mais
 * tolerante, nunca mais rígido). Sem amostra suficiente devolve null.
 */
export function estimateIntervalSeconds(m: PublicMonitor, serverNowMs: number): number | null {
  const checks = m.uptime.last24h.checks;
  if (checks < 2) return null;
  const observedSeconds = Math.min(86_400, (serverNowMs - Date.parse(m.monitoringSince)) / 1000);
  return observedSeconds > 0 ? observedSeconds / checks : null;
}

/** Sem estimativa, qualquer checagem com mais de 15 min já merece um aviso. */
const FALLBACK_STALE_SECONDS = 15 * 60;
const MIN_STALE_SECONDS = 120;
const STALE_FACTOR = 3;

export function checkAgeSeconds(m: PublicMonitor, serverNowMs: number): number | null {
  return m.lastCheck ? (serverNowMs - Date.parse(m.lastCheck.checkedAt)) / 1000 : null;
}

/**
 * true se o monitor está ativo, tem checagem, e ela é bem mais antiga do que a cadência esperada
 * (3 intervalos estimados, mínimo 2 min). Pausado e sem-dados não se aplicam.
 */
export function isCheckStale(m: PublicMonitor, serverNowMs: number): boolean {
  if (m.state !== "operational" && m.state !== "unavailable") return false;
  const age = checkAgeSeconds(m, serverNowMs);
  if (age === null) return false;
  const est = estimateIntervalSeconds(m, serverNowMs);
  const limit = est === null ? FALLBACK_STALE_SECONDS : Math.max(MIN_STALE_SECONDS, est * STALE_FACTOR);
  return age > limit;
}

export type Tone = "loading" | "error" | "empty" | "stale" | "down" | "late" | "partial" | "idle" | "ok";

export interface Summary {
  tone: Tone;
  headline: string;
  detail: string;
}

export interface SummaryInput {
  monitors: PublicMonitor[] | null;
  /** Há erro na atualização mais recente. */
  failing: boolean;
  fetchStale: boolean;
  serverNowMs: number;
  lastSuccessLabel?: string;
}

/**
 * Resumo geral. Regra de ouro: "tudo operacional" só quando há dados frescos, nenhum sistema com problema,
 * nenhuma checagem atrasada e nenhum sistema sem dados. Ausência de dado nunca vira "ok".
 */
export function summarize(i: SummaryInput): Summary {
  const { monitors } = i;
  if (monitors === null) {
    return i.failing
      ? { tone: "error", headline: "Não foi possível carregar o estado dos sistemas", detail: "Nenhuma informação disponível no momento. Tentaremos de novo automaticamente." }
      : { tone: "loading", headline: "Carregando o estado dos sistemas", detail: "" };
  }
  if (monitors.length === 0) {
    return { tone: "empty", headline: "Nenhum sistema monitorado ainda", detail: "Quando houver sistemas cadastrados, o estado de cada um aparece aqui." };
  }

  const down = monitors.filter((m) => m.state === "unavailable");
  const active = monitors.filter((m) => m.state === "operational" || m.state === "unavailable");
  const paused = monitors.filter((m) => m.state === "paused").length;
  const noData = monitors.filter((m) => m.state === "no_data").length;
  const late = active.filter((m) => isCheckStale(m, i.serverNowMs)).length;

  if (i.fetchStale) {
    const known = down.length > 0 ? ` Último estado conhecido: ${down.length === 1 ? "1 sistema com problema" : `${down.length} sistemas com problema`}.` : "";
    return {
      tone: "stale",
      headline: "Dados desatualizados",
      detail: `Não conseguimos atualizar${i.lastSuccessLabel ? ` desde ${i.lastSuccessLabel}` : ""}. O que aparece abaixo pode não refletir a situação atual.${known}`,
    };
  }
  if (down.length > 0) {
    return {
      tone: "down",
      headline: down.length === 1 ? "1 sistema com problema" : `${down.length} sistemas com problema`,
      detail: active.length > down.length ? `Os demais sistemas ativos estão operacionais${late > 0 ? ", mas há checagens atrasadas" : ""}.` : "",
    };
  }
  if (active.length === 0) {
    return {
      tone: "idle",
      headline: noData > 0 ? "Aguardando as primeiras checagens" : "Nenhum sistema está sendo checado",
      detail: paused > 0 ? `${paused === 1 ? "1 sistema pausado" : `${paused} sistemas pausados`}.` : "",
    };
  }
  if (late > 0) {
    return {
      tone: "late",
      headline: "Checagens atrasadas",
      detail: `${late === 1 ? "Uma checagem está" : `${late} checagens estão`} mais atrasada${late === 1 ? "" : "s"} do que o esperado. Não dá para afirmar que está tudo bem.`,
    };
  }
  if (noData > 0) {
    return {
      tone: "partial",
      headline: "Sistemas checados estão operacionais",
      detail: `${noData === 1 ? "1 sistema ainda não tem" : `${noData} sistemas ainda não têm`} nenhuma checagem${paused > 0 ? `; ${paused === 1 ? "1 pausado" : `${paused} pausados`}` : ""}.`,
    };
  }
  return {
    tone: "ok",
    headline: paused > 0 ? "Todos os sistemas ativos estão operacionais" : "Todos os sistemas estão operacionais",
    detail: paused > 0 ? `${paused === 1 ? "1 sistema pausado não está" : `${paused} sistemas pausados não estão`} sendo checado${paused === 1 ? "" : "s"}.` : "",
  };
}
