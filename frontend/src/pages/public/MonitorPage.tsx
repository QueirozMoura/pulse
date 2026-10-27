import { Link, useParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import { publicApi } from "../../api/endpoints";
import { CheckStrip } from "../../components/CheckStrip";
import { EmptyState, ErrorState, Notice, Skeleton } from "../../components/feedback";
import { Freshness } from "../../components/Freshness";
import { LatencyChart } from "../../components/LatencyChart";
import { CheckTable, IncidentList } from "../../components/lists";
import { StateBadge } from "../../components/StateBadge";
import { StateGlyph } from "../../components/StateGlyph";
import { UptimeFigure } from "../../components/UptimeFigure";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { usePagedFeed } from "../../hooks/usePagedFeed";
import { useNow, usePolling } from "../../hooks/usePolling";
import { checkAgeSeconds, isCheckStale, isFetchStale, POLL_MS } from "../../lib/freshness";
import { errorKindLabel, formatAgo, formatDateTime, formatLatency } from "../../lib/format";
import { mergeById, mergeLatest } from "../../lib/history";

const HISTORY_PAGE = 50;

export function MonitorPage() {
  const { id = "" } = useParams();
  const monitor = usePolling((s) => publicApi.monitor(id, s), POLL_MS, [id]);
  const now = useNow(5000);

  const history = usePagedFeed({
    fetchPage: async (cursor, signal) => {
      const r = await publicApi.history(id, { limit: HISTORY_PAGE, cursor, signal });
      return { items: r.checks, nextCursor: r.nextCursor };
    },
    merge: (cur, latest) => {
      const m = mergeLatest(cur && { checks: cur.items, nextCursor: cur.nextCursor }, { checks: latest.items, nextCursor: latest.nextCursor });
      return { items: m.checks, nextCursor: m.nextCursor };
    },
    keyOf: (c) => c.checkedAt,
    pollMs: POLL_MS,
    deps: [id],
  });
  const incidents = usePagedFeed({
    fetchPage: async (cursor, signal) => {
      const r = await publicApi.incidents({ monitorId: id, limit: 10, cursor, signal });
      return { items: r.incidents, nextCursor: r.nextCursor };
    },
    merge: mergeById,
    keyOf: (i) => i.id,
    pollMs: POLL_MS,
    deps: [id],
  });

  const m = monitor.data;
  useDocumentTitle(m ? `${m.name} — Pulse` : "Sistema — Pulse");

  const gone = monitor.error instanceof ApiError && (monitor.error.status === 404 || monitor.error.status === 400);
  // GET /public/monitors/:id não traz `generatedAt` (só a lista traz): aqui as idades usam o relógio do navegador.
  const refNow = now;
  const fetchStale = m !== null && isFetchStale(monitor.lastSuccessAt, now);
  const late = m !== null && !fetchStale && isCheckStale(m, refNow);

  return (
    <>
      <Link to="/" className="back-link">← Todos os sistemas</Link>

      {monitor.loading && <Skeleton lines={5} label="Carregando sistema" />}

      {gone && (
        <ErrorState title="Sistema não encontrado">
          Este endereço não corresponde a nenhum sistema monitorado. Ele pode ter sido removido. <Link to="/">Ver todos os sistemas</Link>.
        </ErrorState>
      )}
      {!gone && !m && !monitor.loading && monitor.error && (
        <ErrorState title="Não foi possível carregar este sistema" onRetry={monitor.refetch}>
          Isso não significa que ele esteja fora do ar; só que não conseguimos consultá-lo agora.
        </ErrorState>
      )}

      {m && (
        <>
          <header className={`detail-head detail-head--${m.state}`}>
            <h1 className="detail-head__title">{m.name}</h1>
            <StateBadge state={m.state} late={late} />
          </header>
          {fetchStale && (
            <Notice tone="warn" title="Dados desatualizados">
              Não conseguimos atualizar este sistema há algum tempo. O estado exibido pode não refletir a situação atual.
            </Notice>
          )}
          {m.state === "paused" && <Notice tone="info" title="Sistema pausado">Ele não está sendo checado. Os dados abaixo são de antes da pausa.</Notice>}
          {m.state === "no_data" && <Notice tone="info" title="Ainda sem checagens">Nenhuma checagem aconteceu até agora; não sabemos o estado deste sistema.</Notice>}
          {late && <Notice tone="warn" title="Checagem atrasada">A última checagem foi {formatAgo(checkAgeSeconds(m, refNow) ?? 0)}, mais do que o esperado. O estado pode estar desatualizado.</Notice>}
          {m.ongoingIncident && m.state !== "paused" && (
            <Notice tone="error" title="Incidente em andamento">
              Começou em {formatDateTime(m.ongoingIncident.startedAt)} ({formatAgo((refNow - Date.parse(m.ongoingIncident.startedAt)) / 1000)}).
            </Notice>
          )}

          <dl className="facts facts--detail">
            <div className="fact">
              <dt>Última checagem</dt>
              <dd>
                {m.lastCheck ? (
                  <>
                    <time dateTime={m.lastCheck.checkedAt}>{formatAgo(checkAgeSeconds(m, refNow) ?? 0)}</time>
                    <small className="fact__sub">{formatDateTime(m.lastCheck.checkedAt)}</small>
                    {!m.lastCheck.success && <small className="fact__sub">{errorKindLabel(m.lastCheck.errorKind)}</small>}
                  </>
                ) : (
                  <span className="fact__none">Nenhuma ainda</span>
                )}
              </dd>
            </div>
            <div className="fact">
              <dt>Latência</dt>
              <dd>{m.lastCheck?.success ? formatLatency(m.lastCheck.latencyMs) : <span className="fact__none">—</span>}</dd>
            </div>
            <div className="fact">
              <dt>Uptime 24 h</dt>
              <dd><UptimeFigure window={m.uptime.last24h} /></dd>
            </div>
            <div className="fact">
              <dt>Uptime 7 dias</dt>
              <dd><UptimeFigure window={m.uptime.last7d} /></dd>
            </div>
            <div className="fact">
              <dt>Monitorado desde</dt>
              <dd><time dateTime={m.monitoringSince}>{formatDateTime(m.monitoringSince)}</time></dd>
            </div>
          </dl>
          <Freshness lastSuccessAt={monitor.lastSuccessAt} nowMs={now} failing={monitor.error !== null} refreshing={monitor.refreshing} onRefresh={() => { monitor.refetch(); history.refetch(); incidents.refetch(); }} />
        </>
      )}

      {m && (
        <>
          <section className="section" aria-labelledby="hist-title">
            <div className="section__head">
              <h2 id="hist-title" className="section__title">Histórico recente</h2>
            </div>
            {history.items === null && history.loading && <Skeleton lines={4} label="Carregando histórico" />}
            {history.items === null && !history.loading && history.error && <ErrorState title="Não foi possível carregar o histórico" onRetry={history.refetch} />}
            {history.items && history.items.length === 0 && <EmptyState title="Sem checagens registradas">Quando as primeiras checagens acontecerem, o histórico aparece aqui.</EmptyState>}
            {history.items && history.items.length > 0 && (
              <>
                <CheckStrip checks={history.items} />
                <LatencyChart checks={history.items} />
              </>
            )}
          </section>

          <section className="section" aria-labelledby="inc-title">
            <div className="section__head">
              <h2 id="inc-title" className="section__title">Incidentes</h2>
            </div>
            {incidents.items === null && incidents.loading && <Skeleton lines={2} label="Carregando incidentes" />}
            {incidents.items === null && !incidents.loading && incidents.error && <ErrorState title="Não foi possível carregar os incidentes" onRetry={incidents.refetch} />}
            {incidents.items && incidents.items.length === 0 && (
              <EmptyState title="Nenhum incidente neste sistema">
                <StateGlyph kind="operational" height={14} /> Um incidente é aberto depois de duas falhas seguidas e resolvido na primeira checagem bem-sucedida.
              </EmptyState>
            )}
            {incidents.items && incidents.items.length > 0 && <IncidentList incidents={incidents.items} showMonitor={false} nowMs={refNow} />}
            {incidents.hasMore && (
              <button type="button" className="btn btn--quiet more" onClick={incidents.loadMore} disabled={incidents.loadingMore}>
                {incidents.loadingMore ? "Carregando…" : "Carregar incidentes mais antigos"}
              </button>
            )}
            {incidents.moreError && <Notice tone="error" title="Não foi possível carregar mais incidentes" />}
          </section>

          <section className="section" aria-labelledby="checks-title">
            <div className="section__head">
              <h2 id="checks-title" className="section__title">Checagens</h2>
              {history.items && <p className="section__note">{history.items.length} carregadas</p>}
            </div>
            {history.items && history.items.length > 0 && <CheckTable checks={history.items} nowMs={refNow} />}
            {history.hasMore && (
              <button type="button" className="btn btn--quiet more" onClick={history.loadMore} disabled={history.loadingMore}>
                {history.loadingMore ? "Carregando…" : "Carregar checagens mais antigas"}
              </button>
            )}
            {history.moreError && <Notice tone="error" title="Não foi possível carregar mais checagens" />}
          </section>
        </>
      )}
    </>
  );
}
