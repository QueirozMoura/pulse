import { useCallback, useEffect, useRef, useState } from "react";

export interface PollingState<T> {
  data: T | null;
  /** Erro da última tentativa. Os dados anteriores são mantidos (e marcados como possivelmente velhos pelo chamador). */
  error: Error | null;
  /** true só antes da primeira resposta. */
  loading: boolean;
  /** Relógio local do último sucesso e da resposta mais recente. */
  lastSuccessAt: number | null;
  refreshing: boolean;
  refetch: () => void;
}

const MAX_BACKOFF_MS = 60_000;

/**
 * Busca `fetcher` agora e a cada `intervalMs`, sem recarregar a página. Para quando a aba está oculta e atualiza
 * ao voltar. Em erro, tenta de novo com espera crescente (até 1 min). Cancela requisições ao desmontar.
 */
export function usePolling<T>(fetcher: (signal: AbortSignal) => Promise<T>, intervalMs: number, deps: unknown[] = []): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const trigger = useRef<() => void>(() => undefined);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let failures = 0;
    setData(null);
    setError(null);
    setLoading(true);
    setLastSuccessAt(null);

    const schedule = () => {
      if (cancelled) return;
      const wait = failures === 0 ? intervalMs : Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS);
      timer = setTimeout(run, wait);
    };

    const run = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) return schedule(); // aba oculta: não gasta rede
      controller?.abort();
      controller = new AbortController();
      setRefreshing(true);
      try {
        const result = await fetcherRef.current(controller.signal);
        if (cancelled) return;
        failures = 0;
        setData(result);
        setError(null);
        setLastSuccessAt(Date.now());
      } catch (e) {
        if (cancelled || (e instanceof DOMException && e.name === "AbortError")) return;
        failures += 1;
        setError(e instanceof Error ? e : new Error("Falha desconhecida"));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
          clearTimeout(timer);
          schedule();
        }
      }
    };

    trigger.current = () => {
      clearTimeout(timer);
      void run();
    };
    const onVisible = () => {
      if (!document.hidden) trigger.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    void run();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);

  const refetch = useCallback(() => trigger.current(), []);
  return { data, error, loading, lastSuccessAt, refreshing, refetch };
}

/** Relógio que re-renderiza a cada `everyMs` (para "há 12 s" andar sozinho). */
export function useNow(everyMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
