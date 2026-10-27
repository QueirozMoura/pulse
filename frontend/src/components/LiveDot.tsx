import type { PublicState } from "../api/types";

export type LiveKind = PublicState | "late";

/**
 * Ponto de status "vivo". Cada estado tem comportamento próprio (e o texto do estado sempre está por perto):
 * operacional respira, indisponível pulsa mais rápido, atenção (atrasado) respira devagar em âmbar,
 * pausado é estático e sem dados é um anel vazio tracejado.
 */
export function LiveDot({ kind, size = "md" }: { kind: LiveKind; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`live live--${kind} live--${size}`} aria-hidden="true">
      <i className="live__ring" />
      <i className="live__ring live__ring--b" />
      <i className="live__core" />
    </span>
  );
}
