import type { Incident, LastCheck } from "../api/types";

/** Percentil por interpolação linear sobre valores já ordenados. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

export interface LatencyStats {
  /** Quantas checagens bem-sucedidas entraram na conta. */
  samples: number;
  median: number;
  p95: number;
  max: number;
}

/** Só checagens bem-sucedidas: o tempo até falhar (ex.: timeout de 10 s) não é latência de resposta. null sem amostras. */
export function latencyStats(checks: LastCheck[]): LatencyStats | null {
  const v = checks.filter((c) => c.success).map((c) => c.latencyMs).sort((a, b) => a - b);
  if (v.length === 0) return null;
  return { samples: v.length, median: percentile(v, 0.5)!, p95: percentile(v, 0.95)!, max: v[v.length - 1]! };
}

export interface Band {
  start: number;
  end: number;
  open: boolean;
  incidentId: string;
}

/** Recorta os incidentes na janela [from, to] do gráfico. Incidente aberto vai até `to`. Fora da janela é descartado. */
export function incidentBands(incidents: Incident[], from: number, to: number): Band[] {
  const out: Band[] = [];
  for (const i of incidents) {
    const s = Date.parse(i.startedAt);
    const e = i.resolvedAt ? Date.parse(i.resolvedAt) : to;
    if (e < from || s > to) continue;
    out.push({ start: Math.max(s, from), end: Math.min(e, to), open: i.resolvedAt === null, incidentId: i.id });
  }
  return out;
}
