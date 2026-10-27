import { m } from "motion/react";
import { Link } from "react-router-dom";
import type { PublicMonitor } from "../api/types";
import { useChangeFlash } from "../hooks/useChangeFlash";
import { checkAgeSeconds, isCheckStale } from "../lib/freshness";
import { errorKindLabel, formatAgo, formatClock, formatDateTime, formatDayMonth, formatLatency } from "../lib/format";
import { AnimatedNumber } from "./AnimatedNumber";
import { LiveDot, type LiveKind } from "./LiveDot";
import { StateBadge } from "./StateBadge";
import { UptimeMeter } from "./UptimeMeter";

/**
 * Painel de um sistema. A hierarquia acompanha a gravidade: indisponível ocupa duas colunas e mostra o incidente;
 * operacional é compacto; pausado e sem dados ficam atenuados e hachurados (não "parecem ok").
 */
export function SystemCard({ m: mon, serverNow, dataIsStale, index }: { m: PublicMonitor; serverNow: number; dataIsStale: boolean; index: number }) {
  const late = !dataIsStale && isCheckStale(mon, serverNow);
  const last = mon.lastCheck;
  const age = checkAgeSeconds(mon, serverNow);
  const flash = useChangeFlash(`${mon.state}|${late}|${mon.ongoingIncident?.id ?? ""}`);
  const dot: LiveKind = dataIsStale ? "no_data" : late ? "late" : mon.state;

  return (
    <m.li
      layout="position"
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 340, damping: 32, delay: Math.min(index, 8) * 0.05 }}
      className={`unit unit--${mon.state}${late ? " unit--late" : ""}${flash ? " unit--flash" : ""}`}
    >
      <span className="unit__rail" aria-hidden="true" />
      <div className="unit__head">
        <LiveDot kind={dot} />
        <h3 className="unit__name">
          <Link to={`/s/${mon.id}`}>{mon.name}</Link>
        </h3>
        <StateBadge state={mon.state} late={late} />
      </div>

      {mon.state === "paused" && <p className="unit__note">Este sistema está pausado e não está sendo checado.</p>}
      {mon.state === "no_data" && <p className="unit__note">Ainda não houve nenhuma checagem. Não sabemos o estado deste sistema.</p>}
      {mon.ongoingIncident && mon.state !== "paused" && (
        <p className="unit__alert">
          <span>
            Incidente em andamento desde <time dateTime={mon.ongoingIncident.startedAt} title={formatDateTime(mon.ongoingIncident.startedAt)}>{formatClock(mon.ongoingIncident.startedAt)}</time>{" "}
            <small>{formatDayMonth(mon.ongoingIncident.startedAt)}</small>
          </span>
          <span className="nowrap unit__alert-ago">({formatAgo((serverNow - Date.parse(mon.ongoingIncident.startedAt)) / 1000)})</span>
        </p>
      )}
      {late && last && <p className="unit__note unit__note--late">A última checagem foi {formatAgo(age ?? 0)}, mais do que o esperado. O estado acima pode estar desatualizado.</p>}

      <dl className="unit__facts">
        {last && (
          <div className="fact fact--hero">
            <dt>Latência</dt>
            <dd className="fact__big">{last.success ? <AnimatedNumber value={last.latencyMs} format={formatLatency} /> : <span className="fact__none">—</span>}</dd>
          </div>
        )}
        <div className={`fact${last ? "" : " fact--wide"}`}>
          <dt>Última checagem</dt>
          <dd>
            {last ? (
              <>
                <time dateTime={last.checkedAt} title={formatDateTime(last.checkedAt)}>{formatAgo(age ?? 0)}</time>
                {!last.success && <small className="fact__sub fact__sub--down">{errorKindLabel(last.errorKind) || "Falha"}</small>}
                {mon.state === "paused" && <small className="fact__sub">antes da pausa</small>}
              </>
            ) : (
              <span className="fact__none">Nenhuma ainda</span>
            )}
          </dd>
        </div>
        <div className="fact">
          <dt>Uptime 24 h</dt>
          <dd><UptimeMeter window={mon.uptime.last24h} /></dd>
        </div>
        <div className="fact">
          <dt>Uptime 7 dias</dt>
          <dd><UptimeMeter window={mon.uptime.last7d} /></dd>
        </div>
      </dl>
    </m.li>
  );
}
