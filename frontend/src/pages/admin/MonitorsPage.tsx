import { Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "../../api/client";
import { adminApi } from "../../api/endpoints";
import type { AdminMonitor, PublicState } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { EmptyState, ErrorState, Notice } from "../../components/feedback";
import { Modal } from "../../components/Modal";
import { LiveDot } from "../../components/LiveDot";
import { StateBadge } from "../../components/StateBadge";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { useNow, usePolling } from "../../hooks/usePolling";
import { describeError, type Described } from "../../lib/errorText";
import { formatAgo, formatDateTime, formatDuration, formatTime, plural } from "../../lib/format";
import { intervalLabel, MonitorFormDialog } from "./MonitorFormDialog";

const REFRESH_MS = 20_000;

/** Estado exibido no painel, a partir dos campos administrativos (mesma semântica da API pública). */
export function adminState(m: AdminMonitor): PublicState {
  if (!m.active) return "paused";
  if (m.lastCheckedAt === null) return "no_data";
  return m.status === "UNAVAILABLE" ? "unavailable" : "operational";
}

export function MonitorsPage() {
  useDocumentTitle("Monitores — Pulse");
  const auth = useAuth();
  const list = usePolling((s) => adminApi.list(s), REFRESH_MS);
  const now = useNow(5000);
  const [form, setForm] = useState<AdminMonitor | "new" | null>(null);
  const [toDelete, setToDelete] = useState<AdminMonitor | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<Described | null>(null);
  const [toast, setToast] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [filter, setFilter] = useState<"all" | PublicState>("all");

  // 401 em qualquer chamada = sessão acabou: volta ao login.
  useEffect(() => {
    if (list.error instanceof ApiError && list.error.status === 401) auth.expire();
  }, [list.error]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  /** Trata falhas de sessão de qualquer operação. Devolve true se já tratou (o chamador não precisa mostrar nada). */
  const handleSessionProblem = useCallback(
    (d: Described) => {
      if (d.unauthenticated) { auth.expire(); return true; }
      if (d.csrf) { void auth.refresh(); setProblem(d); setForm(null); return true; }
      return false;
    },
    [auth],
  );

  const run = async (m: AdminMonitor, action: "pause" | "resume", okText: string) => {
    setBusy((b) => ({ ...b, [m.id]: action }));
    setProblem(null);
    try {
      await (action === "pause" ? adminApi.pause(m.id) : adminApi.resume(m.id));
      setToast(okText);
      list.refetch();
    } catch (e) {
      const d = describeError(e);
      if (!handleSessionProblem(d)) { setProblem(d); if (e instanceof ApiError && e.status === 404) list.refetch(); }
    } finally {
      setBusy((b) => { const { [m.id]: _gone, ...rest } = b; return rest; });
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    const m = toDelete;
    setDeleting(true);
    setProblem(null);
    try {
      await adminApi.remove(m.id);
      setToDelete(null);
      setToast(`«${m.name}» foi excluído.`);
      list.refetch();
    } catch (e) {
      const d = describeError(e);
      setToDelete(null);
      if (!handleSessionProblem(d)) { setProblem(d); if (e instanceof ApiError && e.status === 404) list.refetch(); }
    } finally {
      setDeleting(false);
    }
  };

  const monitors = list.data?.monitors ?? null;
  const counts = useMemo(() => (monitors ? count(monitors) : null), [monitors]);
  const visible = monitors ? monitors.filter((x) => filter === "all" || adminState(x) === filter) : null;
  const openNew = () => { setProblem(null); setForm("new"); };

  return (
    <>
      <div className="admin-head">
        <div>
          <h1 className="admin-head__title">Monitores</h1>
          {monitors && <p className="admin-head__sub">{monitors.length === 0 ? "Nenhum monitor cadastrado." : `${plural(monitors.length, "monitor cadastrado", "monitores cadastrados")}.`}</p>}
        </div>
        <button type="button" className="btn btn--primary btn--lg admin-head__cta" onClick={openNew}>
          <Plus size={19} aria-hidden="true" />
          Novo monitor
        </button>
      </div>

      {counts && monitors && monitors.length > 0 && (
        <div className="filters" role="group" aria-label="Filtrar por estado">
          {FILTERS.map(([key, label]) => {
            const n = key === "all" ? monitors.length : counts[key];
            if (key !== "all" && n === 0 && filter !== key) return null;
            return (
              <button key={key} type="button" className={`filter${filter === key ? " is-on" : ""}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>
                {key !== "all" && <LiveDot kind={key} size="sm" />}
                {label} <strong>{n}</strong>
              </button>
            );
          })}
        </div>
      )}

      <div className="toast" role="status" aria-live="polite">{toast}</div>
      {problem && (
        <div className="stack">
          <ErrorState title={problem.title}>
            {problem.text}
            {problem.requestId && <small className="notice__code"> Código: {problem.requestId}</small>}
          </ErrorState>
        </div>
      )}

      {list.loading && <SkeletonRows />}
      {!list.loading && !monitors && list.error && !(list.error instanceof ApiError && list.error.status === 401) && (
        <ErrorState title={describeError(list.error).title} onRetry={list.refetch}>{describeError(list.error).text}</ErrorState>
      )}
      {monitors && list.error && !(list.error instanceof ApiError && list.error.status === 401) && (
        <div className="stack"><Notice tone="warn" title="Não foi possível atualizar a lista">Mostrando a última leitura{list.lastSuccessAt ? `, feita ${formatAgo((now - list.lastSuccessAt) / 1000)}` : ""}. Tentando de novo automaticamente.</Notice></div>
      )}
      {monitors && monitors.length === 0 && (
        <EmptyState
          title="Você ainda não monitora nada"
          action={<button type="button" className="btn btn--primary" onClick={openNew}><Plus size={18} aria-hidden="true" />Novo monitor</button>}
        >
          Cadastre o primeiro monitor com o botão “Novo monitor”. A primeira checagem acontece na próxima rodada do worker, o que pode levar até cerca de 15 minutos no plano gratuito.
        </EmptyState>
      )}
      {visible && monitors && monitors.length > 0 && visible.length === 0 && <EmptyState title="Nenhum monitor neste filtro">Escolha outro estado acima para ver os demais.</EmptyState>}

      {visible && visible.length > 0 && (
        <ul className="admin-list">
          <AnimatePresence initial={false}>
            {visible.map((mon) => {
              const state = adminState(mon);
              const b = busy[mon.id];
              return (
                <m.li key={mon.id} layout="position" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }} transition={{ type: "spring", stiffness: 360, damping: 32 }}>
                  <article className={`rowcard rowcard--${state}`} aria-label={mon.name} aria-busy={Boolean(b)}>
                    <span className="unit__rail" aria-hidden="true" />
                    <div className="rowcard__main">
                      <LiveDot kind={state} />
                      <div className="rowcard__id">
                        <h2 className="rowcard__name">{mon.name}</h2>
                        <span className="rowcard__url">{mon.url}</span>
                      </div>
                      <div className="rowcard__state">
                        <StateBadge state={state} />
                        {mon.publicVisible === false && <small className="rowcard__flag" title="Fora da página pública e das métricas públicas">Interno</small>}
                        {state === "operational" && mon.consecutiveFailures > 0 && <small className="rowcard__warn">{plural(mon.consecutiveFailures, "falha recente", "falhas seguidas")}</small>}
                      </div>
                    </div>
                    <dl className="rowcard__meta">
                      <div><dt>Intervalo</dt><dd>{intervalLabel(mon.intervalSeconds)}</dd></div>
                      <div>
                        <dt>Última checagem</dt>
                        <dd>{mon.lastCheckedAt ? <time dateTime={mon.lastCheckedAt} title={formatDateTime(mon.lastCheckedAt)}>{formatAgo((now - Date.parse(mon.lastCheckedAt)) / 1000)}</time> : "Nenhuma ainda"}</dd>
                      </div>
                      {mon.active && <div><dt>Próxima</dt><dd>{nextIn(mon, now)}</dd></div>}
                    </dl>
                    <div className="rowcard__actions">
                      <button type="button" className="btn btn--sm" onClick={() => { setProblem(null); setForm(mon); }} disabled={Boolean(b)} aria-label={`Editar ${mon.name}`}>
                        <Pencil size={15} aria-hidden="true" />Editar
                      </button>
                      {mon.active ? (
                        <button type="button" className="btn btn--sm" onClick={() => run(mon, "pause", `«${mon.name}» foi pausado.`)} disabled={Boolean(b)} aria-label={`Pausar ${mon.name}`}>
                          <Pause size={15} aria-hidden="true" />{b === "pause" ? "Pausando…" : "Pausar"}
                        </button>
                      ) : (
                        <button type="button" className="btn btn--sm" onClick={() => run(mon, "resume", `«${mon.name}» foi retomado.`)} disabled={Boolean(b)} aria-label={`Retomar ${mon.name}`}>
                          <Play size={15} aria-hidden="true" />{b === "resume" ? "Retomando…" : "Retomar"}
                        </button>
                      )}
                      <button type="button" className="btn btn--sm btn--danger" onClick={() => { setProblem(null); setToDelete(mon); }} disabled={Boolean(b)} aria-label={`Excluir ${mon.name}`}>
                        <Trash2 size={15} aria-hidden="true" />Excluir
                      </button>
                    </div>
                  </article>
                </m.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}

      <MonitorFormDialog
        target={form}
        onClose={() => setForm(null)}
        onSessionProblem={(d) => { handleSessionProblem(d); }}
        onSaved={(m, created) => { setForm(null); setToast(created ? `«${m.name}» foi cadastrado.` : `«${m.name}» foi atualizado.`); list.refetch(); }}
      />

      <Modal open={toDelete !== null} onClose={() => !deleting && setToDelete(null)} titleId="delete-title" role="alertdialog">
        {toDelete && (
          <div className="modal__body">
            <h2 id="delete-title" className="modal__title">Excluir «{toDelete.name}»?</h2>
            <p>Isso apaga o monitor, todo o histórico de checagens e os incidentes dele, e ele some da página pública. <strong>Não dá para desfazer.</strong></p>
            <p className="modal__aside">Se só quer parar de checar por um tempo, use “Pausar”.</p>
            <div className="modal__actions">
              <button type="button" className="btn btn--ghost" data-autofocus onClick={() => setToDelete(null)} disabled={deleting}>Cancelar</button>
              <button type="button" className="btn btn--danger-solid" onClick={confirmDelete} disabled={deleting}>{deleting ? "Excluindo…" : "Excluir monitor"}</button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

function nextIn(m: AdminMonitor, nowMs: number): string {
  // A hora é o mais cedo possível, não uma promessa: o worker agendado pode atrasar.
  const secs = Math.round((Date.parse(m.nextCheckAt) - nowMs) / 1000);
  return secs <= 0 ? "na próxima rodada" : `a partir de ${formatTime(Date.parse(m.nextCheckAt))}`;
}

function count(ms: AdminMonitor[]) {
  const c = { operational: 0, unavailable: 0, paused: 0, no_data: 0 };
  for (const m of ms) c[adminState(m)]++;
  return c;
}

const FILTERS: ["all" | PublicState, string][] = [
  ["all", "Todos"],
  ["operational", "Operacionais"],
  ["unavailable", "Indisponíveis"],
  ["paused", "Pausados"],
  ["no_data", "Sem dados"],
];

function SkeletonRows() {
  return (
    <div className="admin-list" role="status" aria-label="Carregando monitores">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rowcard rowcard--skeleton" style={{ animationDelay: `${i * 90}ms` }}>
          <span className="skeleton__line skeleton__line--title" />
          <span className="skeleton__line" style={{ width: "60%" }} />
        </div>
      ))}
    </div>
  );
}
