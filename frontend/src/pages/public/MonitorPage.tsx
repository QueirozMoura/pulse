import { ArrowLeft } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import { publicApi } from "../../api/endpoints";
import { AnimatedNumber } from "../../components/AnimatedNumber";
import { CheckStrip } from "../../components/CheckStrip";
import { EmptyState, ErrorState, Notice, Skeleton } from "../../components/feedback";
import { Freshness } from "../../components/Freshness";
import { IncidentTimeline } from "../../components/IncidentTimeline";
import { LatencyChart } from "../../components/LatencyChart";
import { LiveDot, type LiveKind } from "../../components/LiveDot";
import { CheckTable } from "../../components/lists";
import { StateBadge } from "../../components/StateBadge";
import { UptimeMeter } from "../../components/UptimeMeter";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { usePagedFeed } from "../../hooks/usePagedFeed";
import { useNow, usePolling } from "../../hooks/usePolling";
import { checkAgeSeconds, isCheckStale, isFetchStale, POLL_MS } from "../../lib/freshness";
import { errorKindLabel, formatAgo, formatDateTime, formatLatency, plural } from "../../lib/format";
import { mergeById, mergeLatest } from "../../lib/history";
import { latencyStats } from "../../lib/stats";

// 200 é o teto do contrato: dá ao gráfico uma janela longa o bastante para mostrar falhas e recuperações antigas.
const HISTORY_PAGE = 200;
const ROWS_STEP = 15;

export function MonitorPage() {
  const { id = "" } = useParams();
  const monitor = usePolling((s) => publicApi.monitor(id, s), POLL_MS, [id]);
  const now = useNow(5000);
  const [rows, setRows] = useState(ROWS_STEP);

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
  const stats = useMemo(() => (history.items ? latencyStats(history.items) : null), [history.items]);

  const gone = monitor.error instanceof ApiError && (monitor.error.status === 404 || monitor.error.status === 400);
  // GET /public/monitors/:id não traz `generatedAt` (só a lista traz): aqui as idades usam o relógio do navegador.
  const refNow = now;
  const fetchStale = m !== null && isFetchStale(monitor.lastSuccessAt, now);
  const late = m !== null && !fetchStale && isCheckStale(m, refNow);
  const dot: LiveKind = !m ? "no_data" : fetchStale ? "no_data" : late ? "late" : m.state;
  const shown = history.items ? history.items.slice(0, rows) : [];
  const hiddenLocal = history.items ? history.items.length - shown.length : 0;

  return (
    <>
      <Link to="/" className="back-link"><ArrowLeft size={16} aria-hidden="true" />Todos os sistemas</Link>

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
          <header className={`dhead dhead--${m.state}`}>
            <div className="dhead__id">
              <LiveDot kind={dot} size="lg" />
              <div>
                <h1 className="dhead__title">{m.name}</h1>
                <StateBadge state={m.state} late={late} />
              </div>
            </div>
            <div className="dhead__now">
              <span className="dhead__now-label">Latência agora</span>
              <span className="dhead__now-value">{m.lastCheck?.success ? <AnimatedNumber value={m.lastCheck.latencyMs} format={formatLatency} /> : "—"}</span>
              <span className="dhead__now-sub">
                {m.lastCheck ? (
                  <>
                    checagem <time dateTime={m.lastCheck.checkedAt} title={formatDateTime(m.lastCheck.checkedAt)}>{formatAgo(checkAgeSeconds(m, refNow) ?? 0)}</time>
                    {!m.lastCheck.success && <strong className="dhead__fail"> {errorKindLabel(m.lastCheck.errorKind)}</strong>}
                  </>
                ) : (
                  "nenhuma checagem ainda"
                )}
              </span>
            </div>
          </header>

          <div className="notices">
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
          </div>

          <dl className="stats">
            <div className="stat stat--meter">
              <dt>Uptime 24 h</dt>
              <dd><UptimeMeter window={m.uptime.last24h} /></dd>
            </div>
            <div className="stat stat--meter">
              <dt>Uptime 7 dias</dt>
              <dd><UptimeMeter window={m.uptime.last7d} /></dd>
            </div>
            <div className="stat stat--meter">
              <dt>Monitorado desde</dt>
              <dd className="stat__date"><time dateTime={m.monitoringSince}>{formatDateTime(m.monitoringSince)}</time></dd>
            </div>
            <div className="stat">
              <dt>Mediana</dt>
              <dd>{stats ? formatLatency(stats.median) : <span className="fact__none">—</span>}</dd>
              <small>{stats ? `de ${plural(stats.samples, "checagem", "checagens")} com sucesso` : "sem checagens com sucesso"}</small>
            </div>
            <div className="stat">
              <dt>p95</dt>
              <dd>{stats ? formatLatency(stats.p95) : <span className="fact__none">—</span>}</dd>
              <small>95% responderam em até isso</small>
            </div>
            <div className="stat">
              <dt>Máxima</dt>
              <dd>{stats ? formatLatency(stats.max) : <span className="fact__none">—</span>}</dd>
              <small>pior resposta bem-sucedida</small>
            </div>
          </dl>
          <Freshness lastSuccessAt={monitor.lastSuccessAt} nowMs={now} failing={monitor.error !== null} stale={fetchStale} refreshing={monitor.refreshing} onRefresh={() => { monitor.refetch(); history.refetch(); incidents.refetch(); }} />
        </>
      )}

      {m && (
        <>
          <section className="section" aria-labelledby="hist-title">
            <div className="section__head">
              <h2 id="hist-title" className="section__title">Histórico recente</h2>
              <p className="section__note">As estatísticas acima usam as checagens carregadas aqui.</p>
            </div>
            {history.items === null && history.loading && <Skeleton lines={5} label="Carregando histórico" />}
            {history.items === null && !history.loading && history.error && <ErrorState title="Não foi possível carregar o histórico" onRetry={history.refetch} />}
            {history.items && history.items.length === 0 && <EmptyState title="Sem checagens registradas">Quando as primeiras checagens acontecerem, o histórico aparece aqui.</EmptyState>}
            {history.items && history.items.length > 0 && (
              <div className="panel">
                <LatencyChart checks={history.items} incidents={incidents.items ?? []} />
                <CheckStrip checks={history.items} />
              </div>
            )}
          </section>

          <section className="section" aria-labelledby="inc-title">
            <div className="section__head">
              <h2 id="inc-title" className="section__title">Incidentes</h2>
            </div>
            {incidents.items === null && incidents.loading && <Skeleton lines={3} label="Carregando incidentes" />}
            {incidents.items === null && !incidents.loading && incidents.error && <ErrorState title="Não foi possível carregar os incidentes" onRetry={incidents.refetch} />}
            {incidents.items && incidents.items.length === 0 && (
              <EmptyState title="Nenhum incidente neste sistema">Um incidente é aberto depois de duas falhas seguidas e resolvido na primeira checagem bem-sucedida.</EmptyState>
            )}
            {incidents.items && incidents.items.length > 0 && <IncidentTimeline incidents={incidents.items} showMonitor={false} nowMs={refNow} />}
            {incidents.hasMore && (
              <button type="button" className="btn btn--ghost more" onClick={incidents.loadMore} disabled={incidents.loadingMore}>
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
            {history.items && history.items.length > 0 && <CheckTable checks={shown} nowMs={refNow} />}
            <div className="more-row">
              {hiddenLocal > 0 && (
                <button type="button" className="btn btn--ghost more" onClick={() => setRows((r) => r + 50)}>
                  Mostrar mais {Math.min(50, hiddenLocal)} checagens
                </button>
              )}
              {hiddenLocal === 0 && history.hasMore && (
                <button type="button" className="btn btn--ghost more" onClick={history.loadMore} disabled={history.loadingMore}>
                  {history.loadingMore ? "Carregando…" : "Carregar checagens mais antigas"}
                </button>
              )}
            </div>
            {history.moreError && <Notice tone="error" title="Não foi possível carregar mais checagens" />}
          </section>
        </>
      )}
    </>
  );
}
