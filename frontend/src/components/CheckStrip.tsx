import { useRef } from "react";
import type { LastCheck } from "../api/types";
import { useElementWidth } from "../hooks/useElementWidth";
import { formatDateTime } from "../lib/format";

const MAX_SHOWN = 80;
const TICK_PX = 8; // largura aproximada de um traço + o espaço entre eles

/**
 * Faixa das últimas checagens, da mais antiga (esquerda) à mais recente (direita): sucesso = traço curto,
 * falha = traço alto com recorte (a forma também diz, não só a cor). Para leitores de tela é uma imagem com resumo;
 * os detalhes estão na tabela de checagens.
 */
export function CheckStrip({ checks }: { checks: LastCheck[] }) {
  const box = useRef<HTMLDivElement>(null);
  const width = useElementWidth(box, 640);
  const shown = Math.max(16, Math.min(MAX_SHOWN, Math.floor(width / TICK_PX)));
  const chrono = [...checks].slice(0, shown).reverse();
  if (chrono.length === 0) return null;
  const fails = chrono.filter((c) => !c.success).length;
  const label = `Últimas ${chrono.length} checagens: ${chrono.length - fails} com sucesso e ${fails} ${fails === 1 ? "falha" : "falhas"}. Da mais antiga para a mais recente.`;
  return (
    <div className="strip" ref={box}>
      <div className="strip__ticks" role="img" aria-label={label}>
        {chrono.map((c) => (
          <span key={c.checkedAt} className={`strip__tick strip__tick--${c.success ? "ok" : "fail"}`} title={`${formatDateTime(c.checkedAt)}: ${c.success ? "sucesso" : "falha"}`} />
        ))}
      </div>
      <p className="strip__legend" aria-hidden="true">
        <span>mais antiga</span>
        <span className="strip__sum"><span className="strip__key strip__key--ok" />{chrono.length - fails} com sucesso<span className="strip__key strip__key--fail" />{fails} {fails === 1 ? "falha" : "falhas"}</span>
        <span>mais recente</span>
      </p>
    </div>
  );
}
