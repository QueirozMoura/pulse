import type { PublicState } from "../api/types";
import { StateGlyph, type GlyphKind } from "./StateGlyph";

export const STATE_LABEL: Record<PublicState, string> = {
  operational: "Operacional",
  unavailable: "Indisponível",
  paused: "Pausado",
  no_data: "Sem dados",
};

/** Selo com glifo + texto. `late` marca checagem atrasada sem fingir que o sistema está bem. */
export function StateBadge({ state, late = false }: { state: PublicState | string; late?: boolean }) {
  const known = state in STATE_LABEL;
  const kind: GlyphKind = late ? "stale" : known ? (state as PublicState) : "no_data";
  const label = known ? STATE_LABEL[state as PublicState] : "Desconhecido";
  return (
    <span className={`badge badge--${late ? "late" : known ? state : "no_data"}`}>
      <StateGlyph kind={kind} height={16} />
      <span>{late ? `${label}, checagem atrasada` : label}</span>
    </span>
  );
}
