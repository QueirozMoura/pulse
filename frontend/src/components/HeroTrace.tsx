import type { Tone } from "../lib/freshness";

// Um batimento (P-Q-R-S-T) com 146 unidades de largura, repetido para preencher a faixa.
const BEAT = "h30c4-9 12-9 16 0h8l5 6 7-40 7 52 5-18h12c5-11 17-11 22 0h34";
const BEATS = `M0 46${BEAT.repeat(8)}`;
const WIDTH = 1168;

type Mode = { cls: string; node: React.ReactNode };

function traceFor(tone: Tone): Mode {
  switch (tone) {
    case "ok":
      return { cls: "trace--ok trace--draw", node: <path d={BEATS} pathLength={1} /> };
    case "partial":
      return { cls: "trace--neutral trace--draw", node: <path d={BEATS} pathLength={1} /> };
    case "late":
      return { cls: "trace--warn", node: <path d={BEATS} strokeDasharray="7 7" /> };
    case "down":
      // Sinal perdido: linha reta, o "x" do corte e o resto pontilhado (não há leitura depois dali).
      return {
        cls: "trace--down",
        node: (
          <>
            <path d="M0 46H760" />
            <path d="M772 32l28 28M800 32l-28 28" />
            <path d={`M830 46H${WIDTH}`} strokeDasharray="1 11" />
          </>
        ),
      };
    case "stale":
    case "error":
      return { cls: "trace--warn", node: <path d={`M0 46H${WIDTH}`} strokeDasharray="1 11" /> };
    default:
      return { cls: "trace--neutral", node: <path d={`M0 46H${WIDTH}`} strokeDasharray="1 11" /> };
  }
}

/** Faixa de traçado no topo da página. Decorativa: o significado está no título e no texto ao lado. */
export function HeroTrace({ tone }: { tone: Tone }) {
  const { cls, node } = traceFor(tone);
  return (
    <svg className={`trace ${cls}`} viewBox={`0 0 ${WIDTH} 92`} preserveAspectRatio="none" aria-hidden="true" focusable="false" key={tone}>
      <g fill="none" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke">
        {node}
      </g>
    </svg>
  );
}
