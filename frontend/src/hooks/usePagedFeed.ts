import { useCallback, useEffect, useRef, useState } from "react";
import type { Paged } from "../lib/history";
import { usePolling } from "./usePolling";

interface Options<T> {
  fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<Paged<T>>;
  /** Junta a primeira página atualizada ao que já está em tela. */
  merge: (current: Paged<T> | null, latest: Paged<T>) => Paged<T>;
  keyOf: (item: T) => string;
  pollMs: number;
  deps: unknown[];
}

export interface PagedFeed<T> {
  items: T[] | null;
  hasMore: boolean;
  /** Erro ao atualizar a primeira página (os itens já carregados continuam em tela). */
  error: Error | null;
  loading: boolean;
  lastSuccessAt: number | null;
  loadMore: () => void;
  loadingMore: boolean;
  moreError: Error | null;
  refetch: () => void;
}

/** Primeira página por polling + "carregar mais" por cursor. As páginas antigas ficam estáveis entre atualizações. */
export function usePagedFeed<T>({ fetchPage, merge, keyOf, pollMs, deps }: Options<T>): PagedFeed<T> {
  const head = usePolling((signal) => fetchPage(undefined, signal), pollMs, deps);
  const [state, setState] = useState<Paged<T> | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<Error | null>(null);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  useEffect(() => {
    setState(null);
    setMoreError(null);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (head.data) setState((cur) => merge(cur, head.data!));
  }, [head.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = useCallback(() => {
    const cursor = state?.nextCursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    fetchRef
      .current(cursor, new AbortController().signal)
      .then((page) =>
        setState((cur) => {
          if (!cur) return cur;
          const seen = new Set(cur.items.map(keyOf));
          return { items: [...cur.items, ...page.items.filter((i) => !seen.has(keyOf(i)))], nextCursor: page.nextCursor };
        }),
      )
      .catch((e) => setMoreError(e instanceof Error ? e : new Error("Falha desconhecida")))
      .finally(() => setLoadingMore(false));
  }, [state?.nextCursor, loadingMore, keyOf]);

  return {
    items: state?.items ?? null,
    hasMore: Boolean(state?.nextCursor),
    error: head.error,
    loading: head.loading,
    lastSuccessAt: head.lastSuccessAt,
    loadMore,
    loadingMore,
    moreError,
    refetch: head.refetch,
  };
}
