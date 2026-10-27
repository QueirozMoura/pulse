import { useEffect, useState, type RefObject } from "react";

/** Largura (px) do conteúdo de um elemento, acompanhando redimensionamentos. Sem ResizeObserver (testes) usa `initial`. */
export function useElementWidth(ref: RefObject<HTMLElement | null>, initial: number): number {
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => entry && setW(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
