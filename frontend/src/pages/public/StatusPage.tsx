import { AnimatePresence } from "motion/react";
import { useMemo } from "react";
import { publicApi } from "../../api/endpoints";
import type { PublicMonitor, PublicState } from "../../api/types";
import { EmptyState, ErrorState, Notice, SkeletonUnits, Skeleton } from "../../components/feedback";
import { Freshness } from "../../components/Freshness";
import { HeroSignal } from "../../components/HeroSignal";
import { IncidentTimeline } from "../../components/IncidentTimeline";
import { LiveDot } from "../../components/LiveDot";
import { SystemCard } from "../../components/SystemCard";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { usePagedFeed } from "../../hooks/usePagedFeed";
import { useAfter, useNow, usePolling } from "../../hooks/usePolling";
import { isFetchStale, POLL_MS, summarize } from "../../lib/freshness";
import { formatPercent, formatTime, plural } from "../../lib/format";
import { mergeById } from "../../lib/history";

// Gravidade primeiro; os cartões atenuados (sem dados, pausado) vão para o fim, onde a altura deles não esburaca a linha dos que importam.
const ORDER = { unavailable: 0, operational: 1, no_data: 2, paused: 3 } as const;
const bySeverity = (a: PublicMonitor, b: PublicMonitor) => (ORDER[a.state] ?? 4) - (ORDER[b.state] ?? 4);

const CHIP: Record<PublicState, [string, string]> = {
  operational: ["operacional", "operacionais"],
  unavailable: ["indisponível", "indisponíveis"],
  paused: ["pausado", "pausados"],
  no_data: ["sem dados", "sem dados"],
};

/** Disponibilidade agregada das últimas 24 h, ponderada pelas checagens reais de cada sistema. null = nenhuma checagem. */
function aggregateUptime(monitors: PublicMonitor[]) {
  let checks = 0;
  let ok = 0;
  for (const m of monitors) {
    checks += m.uptime.last24h.checks;
    ok += m.uptime.last24h.successfulChecks;
  }
  return checks === 0 ? null : { percentage: Math.round((ok / checks) * 10_000) / 100, checks };
}

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

  const monitors = useMemo(() => [...(data?.monitors ?? [])].sort(bySeverity), [data]);
  // Checagem mais recente entre os sistemas ativos: mostra a idade real do dado, não a do último carregamento da página.
  const latestCheckAge = useMemo(() => {
    const times = monitors.filter((m) => m.state !== "paused" && m.lastCheck).map((m) => Date.parse(m.lastCheck!.checkedAt));
    return times.length === 0 ? null : (serverNow - Math.max(...times)) / 1000;
  }, [monitors, serverNow]);
  const slowStart = useAfter(8000, status.loading);
  const counts = useMemo(() => {
    const c: Record<PublicState, number> = { operational: 0, unavailable: 0, paused: 0, no_data: 0 };
    for (const m of monitors) if (m.state in c) c[m.state]++;
    return c;
  }, [monitors]);
  const uptime = useMemo(() => aggregateUptime(monitors), [monitors]);
  const openIncidents = monitors.filter((m) => m.ongoingIncident && m.state !== "paused").length;

  return (
    <>
      <section className={`hero hero--${summary.tone}`} aria-labelledby="hero-title">
        <div className="hero__copy" aria-live="polite" aria-atomic="true">
          <h1 id="hero-title" className="hero__title">{summary.headline}</h1>
          {summary.detail && <p className="hero__detail">{summary.detail}</p>}
        </div>
        <HeroSignal tone={summary.tone} />
        {data && monitors.length > 0 && (
          <div className="hero__foot">
            <ul className={`chips${fetchStale ? " chips--stale" : ""}`} aria-label="Composição do estado geral">
              {(Object.keys(CHIP) as PublicState[]).filter((k) => counts[k] > 0).map((k) => (
                <li key={k} className={`chip chip--${k}`}>
                  <LiveDot kind={fetchStale ? "no_data" : k} size="sm" />
                  <strong>{counts[k]}</strong> {CHIP[k][counts[k] === 1 ? 0 : 1]}
                </li>
              ))}
            </ul>
            <dl className="hero__stats">
              <div>
                <dt>Disponibilidade 24 h</dt>
                <dd>{uptime ? formatPercent(uptime.percentage) : "Sem dados"}</dd>
                <small>{uptime ? `de ${plural(uptime.checks, "checagem", "checagens")}` : "nenhuma checagem na janela"}</small>
              </div>
              <div>
                <dt>Incidentes em andamento</dt>
                <dd>{openIncidents}</dd>
                <small>{openIncidents === 0 ? "nenhum agora" : openIncidents === 1 ? "sistema afetado" : "sistemas afetados"}</small>
              </div>
            </dl>
          </div>
        )}
        <Freshness lastSuccessAt={status.lastSuccessAt} nowMs={now} failing={status.error !== null} stale={fetchStale} refreshing={status.refreshing} onRefresh={status.refetch} rounds={data?.checkRounds?.everyMinutes ?? null} latestCheckAgeSeconds={latestCheckAge} />
      </section>

      <section className="section" aria-labelledby="systems-title">
        <div className="section__head">
          <h2 id="systems-title" className="section__title">Sistemas</h2>
          {data && data.monitors.length > 0 && <p className="section__note">Horários no fuso do seu navegador.</p>}
        </div>
        {status.loading && slowStart && (
          <Notice tone="info" title="O servidor está acordando">
            Para economizar recursos, a API fica em repouso quando ninguém a usa. A primeira consulta pode levar cerca de um minuto.
          </Notice>
        )}
        {status.loading && <SkeletonUnits />}
        {!status.loading && !data && status.error && (
          <ErrorState title="Não foi possível carregar os sistemas" onRetry={status.refetch}>
            O serviço de status não respondeu. Isso não significa que os sistemas estejam fora do ar; só que não conseguimos consultá-los agora.
          </ErrorState>
        )}
        {data && data.monitors.length === 0 && <EmptyState title="Nada para mostrar por enquanto">Cadastre o primeiro monitor no painel administrativo e o estado dele aparece aqui.</EmptyState>}
        {data && monitors.length > 0 && (
          <ul className={`units${fetchStale ? " units--stale" : ""}`}>
            <AnimatePresence initial={true}>
              {monitors.map((m, i) => (
                <SystemCard key={m.id} m={m} serverNow={serverNow} dataIsStale={fetchStale} index={i} />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </section>

      <section className="section" aria-labelledby="inc-title">
        <div className="section__head">
          <h2 id="inc-title" className="section__title">Incidentes recentes</h2>
          {incidents.items && incidents.items.length > 0 && <p className="section__note">Do mais recente para o mais antigo.</p>}
        </div>
        {incidents.items === null && incidents.loading && <Skeleton lines={3} label="Carregando incidentes" />}
        {incidents.items === null && !incidents.loading && incidents.error && (
          <ErrorState title="Não foi possível carregar os incidentes" onRetry={incidents.refetch} />
        )}
        {incidents.items && incidents.items.length === 0 && <EmptyState title="Nenhum incidente registrado">Quando um sistema ficar indisponível, o incidente aparece aqui, com o início e a duração.</EmptyState>}
        {incidents.items && incidents.items.length > 0 && <IncidentTimeline incidents={incidents.items} nowMs={serverNow} />}
        {incidents.items && incidents.error && <Notice tone="warn" title="Incidentes podem estar desatualizados">Não conseguimos atualizar esta lista agora.</Notice>}
        {incidents.hasMore && (
          <button type="button" className="btn btn--ghost more" onClick={incidents.loadMore} disabled={incidents.loadingMore}>
            {incidents.loadingMore ? "Carregando…" : "Carregar incidentes mais antigos"}
          </button>
        )}
        {incidents.moreError && <Notice tone="error" title="Não foi possível carregar mais incidentes" />}
      </section>
    </>
  );
}
