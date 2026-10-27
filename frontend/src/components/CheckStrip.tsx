import type { LastCheck } from "../api/types";
import { formatDateTime } from "../lib/format";

const SHOWN = 60;

/**
 * Faixa das últimas checagens, da mais antiga (esquerda) à mais recente (direita). Sucesso = traço curto;
 * falha = traço alto com recorte (a forma também diz, não só a cor). Para leitores de tela é uma imagem com resumo;
 * os detalhes estão na tabela de checagens.
 */
export function CheckStrip({ checks }: { checks: LastCheck[] }) {
  const chrono = [...checks].slice(0, SHOWN).reverse();
  if (chrono.length === 0) return null;
  const fails = chrono.filter((c) => !c.success).length;
  const label = `Últimas ${chrono.length} checagens: ${chrono.length - fails} com sucesso e ${fails} ${fails === 1 ? "falha" : "falhas"}. Da mais antiga para a mais recente.`;
  return (
    <div className="strip">
      <div className="strip__ticks" role="img" aria-label={label}>
        {chrono.map((c) => (
          <span key={c.checkedAt} className={`strip__tick strip__tick--${c.success ? "ok" : "fail"}`} title={`${formatDateTime(c.checkedAt)}: ${c.success ? "sucesso" : "falha"}`} />
        ))}
      </div>
      <p className="strip__legend" aria-hidden="true">
        <span className="strip__key strip__key--ok" /> sucesso
        <span className="strip__key strip__key--fail" /> falha
        <span className="strip__dir">mais antiga ← → mais recente</span>
      </p>
    </div>
  );
}
