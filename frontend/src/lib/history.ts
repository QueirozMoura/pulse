import type { LastCheck } from "../api/types";

export interface HistoryState {
  checks: LastCheck[];
  nextCursor: string | null;
}

/**
 * Junta a primeira página (atualizada a cada ciclo) com as páginas mais antigas já carregadas pelo usuário, sem
 * lacunas nem repetições. Itens novos entram no topo; o cursor das páginas antigas continua válido (contrato).
 * Se a primeira página nova não encosta no que já tínhamos (ficou muito tempo parado), recomeça dela.
 */
export function mergeLatest(current: HistoryState | null, latest: HistoryState): HistoryState {
  if (!current || current.checks.length === 0) return latest;
  const newestKnown = Date.parse(current.checks[0]!.checkedAt);
  const fresh = latest.checks.filter((c) => Date.parse(c.checkedAt) > newestKnown);
  const touches = fresh.length < latest.checks.length; // a página nova alcança itens que já conhecemos
  if (!touches) return latest;
  return { checks: [...fresh, ...current.checks], nextCursor: current.nextCursor };
}

export function appendOlder(current: HistoryState, older: HistoryState): HistoryState {
  const seen = new Set(current.checks.map((c) => c.checkedAt));
  return { checks: [...current.checks, ...older.checks.filter((c) => !seen.has(c.checkedAt))], nextCursor: older.nextCursor };
}

export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Versão genérica de mergeLatest para listas com `id` (incidentes): itens novos entram no topo, itens já conhecidos
 * são ATUALIZADOS (um incidente aberto vira resolvido), e o cursor das páginas antigas é preservado.
 * Sem sobreposição com o que já existia (ficou muito tempo parado), recomeça da página nova.
 */
export function mergeById<T extends { id: string }>(current: Paged<T> | null, latest: Paged<T>): Paged<T> {
  if (!current || current.items.length === 0 || latest.items.length === 0) return latest;
  const known = new Set(current.items.map((i) => i.id));
  if (!latest.items.some((i) => known.has(i.id))) return latest;
  const updated = new Map(latest.items.map((i) => [i.id, i]));
  const fresh = latest.items.filter((i) => !known.has(i.id));
  return { items: [...fresh, ...current.items.map((i) => updated.get(i.id) ?? i)], nextCursor: current.nextCursor };
}
