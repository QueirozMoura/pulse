import type { PublicState } from "../api/types";

export type GlyphKind = PublicState | "stale";

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 2.4, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/**
 * Cada estado tem um traçado próprio, então o estado nunca depende só da cor:
 * batimento (operacional), linha reta cortada (indisponível), barras (pausado), pontilhado (sem dados / incerto).
 * É decorativo (aria-hidden): o texto do estado sempre aparece ao lado.
 */
export function StateGlyph({ kind, height = 22 }: { kind: GlyphKind; height?: number }) {
  return (
    <svg className={`glyph glyph--${kind}`} viewBox="0 0 44 24" width={(height * 44) / 24} height={height} aria-hidden="true" focusable="false">
      {kind === "operational" && <path {...STROKE} d="M2 14h9l4-9 5 17 4-12 3 4h13" />}
      {kind === "unavailable" && (
        <>
          <path {...STROKE} d="M2 12h25" />
          <path {...STROKE} d="M32 7l9 10M41 7l-9 10" />
        </>
      )}
      {kind === "paused" && (
        <>
          <rect x="14" y="4" width="6" height="16" rx="1.5" fill="currentColor" />
          <rect x="25" y="4" width="6" height="16" rx="1.5" fill="currentColor" />
        </>
      )}
      {(kind === "no_data" || kind === "stale") && <path {...STROKE} strokeDasharray="0.5 6" d="M3 12h38" />}
    </svg>
  );
}
