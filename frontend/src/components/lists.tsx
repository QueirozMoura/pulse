import { Link } from "react-router-dom";
import type { Incident, LastCheck } from "../api/types";
import { errorKindLabel, formatAgo, formatDateTime, formatDuration, formatLatency } from "../lib/format";
import { StateGlyph } from "./StateGlyph";

export function IncidentList({ incidents, showMonitor = true, nowMs }: { incidents: Incident[]; showMonitor?: boolean; nowMs: number }) {
  return (
    <ul className="incidents">
      {incidents.map((i) => {
        const open = i.status === "open";
        const sinceSeconds = (nowMs - Date.parse(i.startedAt)) / 1000;
        return (
          <li key={i.id} className={`incident incident--${i.status}`}>
            <span className={`badge badge--${open ? "unavailable" : "operational"}`}>
              <StateGlyph kind={open ? "unavailable" : "operational"} height={16} />
              <span>{open ? "Em andamento" : "Resolvido"}</span>
            </span>
            <div className="incident__body">
              <p className="incident__title">
                {showMonitor ? <Link to={`/s/${i.monitorId}`}>{i.monitorName}</Link> : <span>Indisponibilidade</span>}
              </p>
              <p className="incident__meta">
                Começou em <time dateTime={i.startedAt}>{formatDateTime(i.startedAt)}</time>
                {open ? <> (<span className="nowrap">{formatAgo(sinceSeconds)}</span>).</> : <>, durou <span className="nowrap">{formatDuration(i.durationSeconds ?? 0)}</span>.</>}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function CheckTable({ checks, nowMs }: { checks: LastCheck[]; nowMs: number }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Checagens recentes, da mais nova para a mais antiga</caption>
        <thead>
          <tr>
            <th scope="col">Quando</th>
            <th scope="col">Resultado</th>
            <th scope="col">HTTP</th>
            <th scope="col">Latência</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.checkedAt}>
              <td>
                <time dateTime={c.checkedAt} title={formatAgo((nowMs - Date.parse(c.checkedAt)) / 1000)}>{formatDateTime(c.checkedAt)}</time>
              </td>
              <td>
                <span className={`result result--${c.success ? "ok" : "fail"}`}>
                  <StateGlyph kind={c.success ? "operational" : "unavailable"} height={14} />
                  {c.success ? "Sucesso" : `Falha: ${errorKindLabel(c.errorKind).toLowerCase()}`}
                </span>
              </td>
              <td>{c.statusCode ?? "—"}</td>
              <td>{formatLatency(c.latencyMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
