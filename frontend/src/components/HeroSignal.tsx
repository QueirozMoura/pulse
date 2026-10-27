import type { Tone } from "../lib/freshness";

// Um batimento (P-Q-R-S-T) com exatamente 150 unidades; 16 repetições = 2400, e o loop percorre 1200 (8 batimentos): sem emenda.
const BEAT = "h38c5-10 13-10 18 0h8l5 8 8-56 8 70 6-22h8c6-14 20-14 26 0h25";
const BEATS = `M0 70${BEAT.repeat(16)}`;
const FLAT = "M0 70H2400";

interface Mode {
  cls: string;
  node: React.ReactNode;
  scroll: boolean;
}

function modeFor(tone: Tone): Mode {
  switch (tone) {
    case "ok":
      return { cls: "signal--ok", scroll: true, node: <path d={BEATS} /> };
    case "partial":
      return { cls: "signal--neutral", scroll: true, node: <path d={BEATS} /> };
    case "late":
      return { cls: "signal--warn", scroll: true, node: <path d={BEATS} strokeDasharray="9 7" /> };
    case "down":
      // Sinal perdido: a linha fica reta; só o "x" fixo marca o ponto da queda.
      return { cls: "signal--down", scroll: false, node: <path d={FLAT} /> };
    case "stale":
    case "error":
      return { cls: "signal--warn", scroll: false, node: <path d={FLAT} strokeDasharray="1 11" /> };
    default:
      return { cls: "signal--neutral", scroll: false, node: <path d={FLAT} strokeDasharray="1 11" /> };
  }
}

/**
 * Osciloscópio do hero. O traçado rola sob uma "cabeça de gravação" (batimento = estado saudável).
 * Para qualquer outro estado o traçado deixa de bater, e isso é parte da mensagem: a linha reta (queda) ou pontilhada
 * (sem leitura confiável) NUNCA se parece com um sistema saudável. Decorativo: o veredito está no título.
 */
export function HeroSignal({ tone }: { tone: Tone }) {
  const { cls, node, scroll } = modeFor(tone);
  return (
    <div className={`signal ${cls}`} aria-hidden="true" key={tone}>
      <div className="signal__grid" />
      <svg className="signal__svg" viewBox="0 0 1200 140" preserveAspectRatio="none" focusable="false">
        <g className={scroll ? "signal__run" : undefined} fill="none" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke">
          {node}
        </g>
      </svg>
      <div className="signal__head">
        <span className="signal__dot" />
      </div>
    </div>
  );
}
