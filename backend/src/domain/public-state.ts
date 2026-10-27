export type PublicState = "operational" | "unavailable" | "paused" | "no_data";

/**
 * Estado exibido ao público. Quatro valores mutuamente exclusivos, nesta precedência:
 * - paused: o monitor foi pausado (não está sendo checado);
 * - no_data: ativo, mas nenhuma checagem aconteceu ainda (não se sabe nada);
 * - unavailable: a última transição de estado foi para indisponível (2+ falhas consecutivas);
 * - operational: caso contrário.
 */
export function publicState(m: {
  active: boolean;
  lastCheckedAt: Date | null;
  status: "OPERATIONAL" | "UNAVAILABLE";
}): PublicState {
  if (!m.active) return "paused";
  if (!m.lastCheckedAt) return "no_data";
  return m.status === "UNAVAILABLE" ? "unavailable" : "operational";
}

export interface UptimeWindow {
  /** Checagens realizadas na janela. É o tamanho da amostra: o front deve exibi-lo junto do percentual. */
  checks: number;
  successfulChecks: number;
  /** null quando não há checagens na janela: nunca inventamos 100% nem 0%. */
  percentage: number | null;
}

export function uptimeWindow(checks: number, successfulChecks: number): UptimeWindow {
  if (checks === 0) return { checks: 0, successfulChecks: 0, percentage: null };
  return { checks, successfulChecks, percentage: Math.round((successfulChecks / checks) * 10_000) / 100 };
}
