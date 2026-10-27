import { RefreshCw } from "lucide-react";
import { formatAgo } from "../lib/format";
import { LiveDot, type LiveKind } from "./LiveDot";
import { Notice } from "./feedback";

/**
 * Barra "ao vivo": quando foi a última leitura bem-sucedida e um botão para atualizar. Se a última tentativa falhou,
 * avisa em texto (anunciado) sem esconder a leitura anterior. O ponto muda de cor conforme a confiança nos dados.
 */
export function Freshness({ lastSuccessAt, nowMs, failing, stale = false, refreshing, onRefresh }: { lastSuccessAt: number | null; nowMs: number; failing: boolean; stale?: boolean; refreshing: boolean; onRefresh: () => void }) {
  const kind: LiveKind = stale || lastSuccessAt === null ? "no_data" : failing ? "late" : "operational";
  return (
    <div className="livebar">
      <div className="livebar__row">
        <LiveDot kind={kind} size="sm" />
        <p className="livebar__text">
          {refreshing ? "Atualizando…" : lastSuccessAt ? `Atualizado ${formatAgo(Math.max(0, (nowMs - lastSuccessAt) / 1000))}` : "Ainda sem atualização"}
        </p>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw size={15} aria-hidden="true" className={refreshing ? "spin" : undefined} />
          Atualizar agora
        </button>
      </div>
      {failing && lastSuccessAt !== null && (
        <Notice tone="warn" title="Falha ao atualizar">
          Mostrando a última leitura bem-sucedida, feita {formatAgo((nowMs - lastSuccessAt) / 1000)}. Tentando de novo automaticamente.
        </Notice>
      )}
    </div>
  );
}
