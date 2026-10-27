import { Check, X } from "lucide-react";
import type { LastCheck } from "../api/types";
import { errorKindLabel, formatAgo, formatClock, formatDate, formatDateTime, formatLatency } from "../lib/format";

/** "Falha de DNS" já diz "falha"; os demais rótulos ganham o prefixo ("Falha: tempo esgotado"). */
function failureText(kind: string | null): string {
  const label = errorKindLabel(kind);
  return label.startsWith("Falha") ? label : `Falha: ${label.toLowerCase()}`;
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
            <tr key={c.checkedAt} className={c.success ? undefined : "is-fail"}>
              <td>
                <time dateTime={c.checkedAt} title={`${formatDateTime(c.checkedAt)}, ${formatAgo((nowMs - Date.parse(c.checkedAt)) / 1000)}`}>
                  <span className="when__date">{formatDate(c.checkedAt)} </span>
                  <span className="when__time">{formatClock(c.checkedAt)}</span>
                </time>
              </td>
              <td>
                <span className={`result result--${c.success ? "ok" : "fail"}`}>
                  {c.success ? <Check size={15} aria-hidden="true" /> : <X size={15} aria-hidden="true" />}
                  {c.success ? "Sucesso" : failureText(c.errorKind)}
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
