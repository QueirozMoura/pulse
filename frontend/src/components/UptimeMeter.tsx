import type { UptimeWindow } from "../api/types";
import { formatPercent, plural } from "../lib/format";
import { AnimatedNumber } from "./AnimatedNumber";

/**
 * Percentual + barra + tamanho da amostra. A barra é a própria conta: a parte bem-sucedida em cor de "ok" e o restante
 * (as falhas) em vermelho. Sem checagens: "Sem dados" e barra hachurada (vazia), nunca 0% nem 100%.
 */
export function UptimeMeter({ window: w }: { window: UptimeWindow }) {
  const pct = w.percentage;
  return (
    <div className={`meter${pct === null ? " meter--empty" : ""}`}>
      <span className="meter__value">{pct === null ? "Sem dados" : <AnimatedNumber value={pct} format={formatPercent} />}</span>
      <span className="meter__bar" aria-hidden="true">
        {pct !== null && <i className="meter__ok" style={{ width: `${pct}%` }} />}
      </span>
      <small className="meter__sample">{pct === null ? "nenhuma checagem na janela" : `de ${plural(w.checks, "checagem", "checagens")}`}</small>
    </div>
  );
}
