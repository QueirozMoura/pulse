import { Link } from "react-router-dom";
import type { Incident } from "../api/types";
import { formatAgo, formatClock, formatDateTime, formatDayMonth, formatDuration } from "../lib/format";

/**
 * Linha do tempo de incidentes. Cada incidente é uma "trilha" com três momentos em destaque:
 * início (nó vermelho) → duração (barra com o tempo fora do ar) → resolução (nó verde) ou, se aberto, "em andamento"
 * com a duração contando até agora. A frase completa fica em texto para leitores de tela.
 */
export function IncidentTimeline({ incidents, showMonitor = true, nowMs }: { incidents: Incident[]; showMonitor?: boolean; nowMs: number }) {
  return (
    <ol className="timeline">
      {incidents.map((i) => {
        const open = i.status === "open";
        const seconds = open ? Math.max(0, (nowMs - Date.parse(i.startedAt)) / 1000) : (i.durationSeconds ?? 0);
        return (
          <li key={i.id} className={`tl tl--${i.status}`}>
            {showMonitor && (
              <p className="tl__monitor">
                <Link to={`/s/${i.monitorId}`}>{i.monitorName}</Link>
              </p>
            )}
            <div className="tl__track">
              <div className="tl__row">
                <span className="tl__node tl__node--down" aria-hidden="true" />
                <div className="tl__txt">
                  <span className="tl__label">Início</span>
                  <time dateTime={i.startedAt} title={formatDateTime(i.startedAt)}>{formatClock(i.startedAt)}</time>
                  <small>{formatDayMonth(i.startedAt)}</small>
                </div>
              </div>
              <div className="tl__row tl__row--span">
                <span className="tl__line" aria-hidden="true" />
                <div className="tl__duration">
                  <strong>{formatDuration(seconds)}</strong>
                  <small>{open ? "e contando" : "fora do ar"}</small>
                </div>
              </div>
              <div className="tl__row">
                <span className={`tl__node ${open ? "tl__node--live" : "tl__node--ok"}`} aria-hidden="true" />
                <div className="tl__txt">
                  {open ? (
                    <>
                      <span className="tl__label tl__label--down">Em andamento</span>
                      <small>ainda indisponível</small>
                    </>
                  ) : (
                    <>
                      <span className="tl__label tl__label--ok">Resolvido</span>
                      <time dateTime={i.resolvedAt ?? undefined} title={i.resolvedAt ? formatDateTime(i.resolvedAt) : undefined}>{i.resolvedAt ? formatClock(i.resolvedAt) : ""}</time>
                      <small>{i.resolvedAt ? formatDayMonth(i.resolvedAt) : ""}</small>
                    </>
                  )}
                </div>
              </div>
            </div>
            <p className="incident__meta sr-only">
              Começou em {formatDateTime(i.startedAt)}
              {open ? ` (${formatAgo(seconds)}), ainda em andamento.` : `, durou ${formatDuration(seconds)}.`}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
