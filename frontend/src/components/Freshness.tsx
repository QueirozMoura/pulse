import { formatAgo } from "../lib/format";
import { Notice } from "./feedback";

/** "Atualizado há 12 s" + botão. Se a última tentativa falhou, avisa em texto (anunciado), sem esconder os dados antigos. */
export function Freshness({ lastSuccessAt, nowMs, failing, refreshing, onRefresh }: { lastSuccessAt: number | null; nowMs: number; failing: boolean; refreshing: boolean; onRefresh: () => void }) {
  return (
    <div className="fresh">
      <p className="fresh__text">
        {refreshing ? "Atualizando…" : lastSuccessAt ? `Atualizado ${formatAgo(Math.max(0, (nowMs - lastSuccessAt) / 1000))}` : "Ainda sem atualização"}
      </p>
      <button type="button" className="btn btn--quiet" onClick={onRefresh} disabled={refreshing}>Atualizar agora</button>
      {failing && lastSuccessAt !== null && (
        <Notice tone="warn" title="Falha ao atualizar">
          Mostrando a última leitura bem-sucedida, feita {formatAgo((nowMs - lastSuccessAt) / 1000)}. Tentando de novo automaticamente.
        </Notice>
      )}
    </div>
  );
}
