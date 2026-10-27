import type { UptimeWindow } from "../api/types";
import { formatPercent, plural } from "../lib/format";

/** Percentual sempre acompanhado do tamanho da amostra. Sem checagens: "Sem dados" (nunca 0% nem 100%). */
export function UptimeFigure({ window: w }: { window: UptimeWindow }) {
  if (w.percentage === null) {
    return (
      <span className="uptime uptime--empty">
        <span className="uptime__value">Sem dados</span>
        <small className="uptime__sample">nenhuma checagem na janela</small>
      </span>
    );
  }
  return (
    <span className="uptime">
      <span className="uptime__value">{formatPercent(w.percentage)}</span>
      <small className="uptime__sample">de {plural(w.checks, "checagem", "checagens")}</small>
    </span>
  );
}
