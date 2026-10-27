import { useMemo } from "react";
import { Link } from "react-router-dom";
import { publicApi } from "../../api/endpoints";
import type { PublicMonitor } from "../../api/types";
import { ErrorState, EmptyState, Notice, Skeleton } from "../../components/feedback";
import { Freshness } from "../../components/Freshness";
import { HeroTrace } from "../../components/HeroTrace";
import { IncidentList } from "../../components/lists";
import { StateBadge } from "../../components/StateBadge";
import { UptimeFigure } from "../../components/UptimeFigure";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { usePagedFeed } from "../../hooks/usePagedFeed";
import { useNow, usePolling } from "../../hooks/usePolling";
import { checkAgeSeconds, isCheckStale, isFetchStale, POLL_MS, summarize } from "../../lib/freshness";
import { errorKindLabel, formatAgo, formatDateTime, formatLatency, formatTime } from "../../lib/format";
import { mergeById } from "../../lib/history";

const ORDER = { unavailable: 0, no_data: 1, operational: 2, paused: 3 } as const;
const bySeverity = (a: PublicMonitor, b: PublicMonitor) => (ORDER[a.state] ?? 4) - (ORDER[b.state] ?? 4);

export function StatusPage() {
  const status = usePolling((s) => publicApi.status(s), POLL_MS);
  const incidents = usePagedFeed({
    fetchPage: async (cursor, signal) => {
      const r = await publicApi.incidents({ limit: 10, cursor, signal });
      return { items: r.incidents, nextCursor: r.nextCursor };
    },
    merge: mergeById,
    keyOf: (i) => i.id,
    pollMs: POLL_MS,
    deps: [],
  });
  const now = useNow(5000);

  // O relógio de referência é o do servidor (generatedAt + tempo decorrido), não o do navegador: um relógio local
  // errado não faz uma checagem recente parecer velha.
  const data = status.data;
  const serverNow = data && status.lastSuccessAt !== null ? Date.parse(data.generatedAt) + Math.max(0, now - status.lastSuccessAt) : now;
  const fetchStale = data !== null && isFetchStale(status.lastSuccessAt, now);

  const summary = useMemo(
    () =>
      summarize({
        monitors: data?.monitors ?? null,
        failing: status.error !== null,
        fetchStale,
        serverNowMs: serverNow,
        lastSuccessLabel: status.lastSuccessAt ? formatTime(status.lastSuccessAt) : undefined,
      }),
    [data, status.error, fetchStale, serverNow, status.lastSuccessAt],
  );
  useDocumentTitle(`${summary.headline} — Pulse`);

  const monitors = [...(data?.monitors ?? [])].sort(bySeverity);

  return (
    <>
      <section className={`hero hero--${summary.tone}`} aria-labelledby="hero-title">
        <div aria-live="polite" aria-atomic="true">
          <h1 id="hero-title" className="hero__title">{summary.headline}</h1>
          {summary.detail && <p className="hero__detail">{summary.detail}</p>}
        </div>
        <HeroTrace tone={summary.tone} />
        <Freshness lastSuccessAt={status.lastSuccessAt} nowMs={now} failing={status.error !== null} refreshing={status.refreshing} onRefresh={status.refetch} />
      </section>

      <section className="section" aria-labelledby="systems-title">
        <div className="section__head">
          <h2 id="systems-title" className="section__title">Sistemas</h2>
          {data && data.monitors.length > 0 && <p className="section__note">Horários no fuso do seu navegador.</p>}
        </div>
        {status.loading && <Skeleton lines={4} label="Carregando sistemas" />}
        {!status.loading && !data && status.error && (
          <ErrorState title="Não foi possível carregar os sistemas" onRetry={status.refetch}>
            O serviço de status não respondeu. Isso não significa que os sistemas estejam fora do ar; só que não conseguimos consultá-los agora.
          </ErrorState>
        )}
        {data && data.monitors.length === 0 && <EmptyState title="Nenhum sistema monitorado ainda">Cadastre o primeiro monitor no painel administrativo.</EmptyState>}
        {data && monitors.length > 0 && (
          <ul className={`systems${fetchStale ? " systems--stale" : ""}`}>
            {monitors.map((m) => (
              <SystemRow key={m.id} m={m} serverNow={serverNow} dataIsStale={fetchStale} />
            ))}
          </ul>
        )}
      </section>

      <section className="section" aria-labelledby="inc-title">
        <div className="section__head">
          <h2 id="inc-title" className="section__title">Incidentes recentes</h2>
        </div>
        {incidents.items === null && incidents.loading && <Skeleton lines={2} label="Carregando incidentes" />}
        {incidents.items === null && !incidents.loading && incidents.error && (
          <ErrorState title="Não foi possível carregar os incidentes" onRetry={incidents.refetch} />
        )}
        {incidents.items && incidents.items.length === 0 && <EmptyState title="Nenhum incidente registrado">Quando um sistema ficar indisponível, o incidente aparece aqui, com o início e a duração.</EmptyState>}
        {incidents.items && incidents.items.length > 0 && <IncidentList incidents={incidents.items} nowMs={serverNow} />}
        {incidents.items && incidents.error && <Notice tone="warn" title="Incidentes podem estar desatualizados">Não conseguimos atualizar esta lista agora.</Notice>}
        {incidents.hasMore && (
          <button type="button" className="btn btn--quiet more" onClick={incidents.loadMore} disabled={incidents.loadingMore}>
            {incidents.loadingMore ? "Carregando…" : "Carregar incidentes mais antigos"}
          </button>
        )}
        {incidents.moreError && <Notice tone="error" title="Não foi possível carregar mais incidentes" />}
      </section>
    </>
  );
}

function SystemRow({ m, serverNow, dataIsStale }: { m: PublicMonitor; serverNow: number; dataIsStale: boolean }) {
  const late = !dataIsStale && isCheckStale(m, serverNow);
  const last = m.lastCheck;
  const age = checkAgeSeconds(m, serverNow);
  return (
    <li className={`system system--${m.state}${late ? " system--late" : ""}`}>
      <div className="system__head">
        <h3 className="system__name">
          <Link to={`/s/${m.id}`}>{m.name}</Link>
        </h3>
        <StateBadge state={m.state} late={late} />
      </div>
      {m.state === "paused" && <p className="system__note">Este sistema está pausado e não está sendo checado.</p>}
      {m.state === "no_data" && <p className="system__note">Ainda não houve nenhuma checagem. Não sabemos o estado deste sistema.</p>}
      {m.ongoingIncident && m.state !== "paused" && (
        <p className="system__note system__note--down">
          Incidente em andamento desde <time dateTime={m.ongoingIncident.startedAt}>{formatDateTime(m.ongoingIncident.startedAt)}</time> (<span className="nowrap">{formatAgo((serverNow - Date.parse(m.ongoingIncident.startedAt)) / 1000)}</span>).
        </p>
      )}
      {late && last && <p className="system__note system__note--late">A última checagem foi {formatAgo(age ?? 0)}, mais do que o esperado. O estado acima pode estar desatualizado.</p>}
      <dl className="facts">
        <div className="fact">
          <dt>Última checagem</dt>
          <dd>
            {last ? (
              <>
                <time dateTime={last.checkedAt} title={formatDateTime(last.checkedAt)}>{formatAgo(age ?? 0)}</time>
                {!last.success && <small className="fact__sub">{errorKindLabel(last.errorKind) || "Falha"}</small>}
                {m.state === "paused" && <small className="fact__sub">antes da pausa</small>}
              </>
            ) : (
              <span className="fact__none">Nenhuma ainda</span>
            )}
          </dd>
        </div>
        <div className="fact">
          <dt>Latência</dt>
          <dd>{last && last.success ? formatLatency(last.latencyMs) : <span className="fact__none">—</span>}</dd>
        </div>
        <div className="fact">
          <dt>Uptime 24 h</dt>
          <dd><UptimeFigure window={m.uptime.last24h} /></dd>
        </div>
        <div className="fact">
          <dt>Uptime 7 dias</dt>
          <dd><UptimeFigure window={m.uptime.last7d} /></dd>
        </div>
      </dl>
    </li>
  );
}
