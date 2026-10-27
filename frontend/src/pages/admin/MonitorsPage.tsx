import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../api/client";
import { adminApi } from "../../api/endpoints";
import type { AdminMonitor, PublicState } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { EmptyState, ErrorState, Notice, Skeleton } from "../../components/feedback";
import { Modal } from "../../components/Modal";
import { StateBadge } from "../../components/StateBadge";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { useNow, usePolling } from "../../hooks/usePolling";
import { describeError, type Described } from "../../lib/errorText";
import { formatAgo, formatDateTime, formatDuration, plural } from "../../lib/format";
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
  const counts = monitors ? count(monitors) : null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-head__title">Monitores</h1>
          {counts && monitors!.length > 0 && <p className="page-head__sub">{summaryText(counts, monitors!.length)}</p>}
        </div>
        <button type="button" className="btn btn--primary" onClick={() => { setProblem(null); setForm("new"); }}>Novo monitor</button>
      </div>

      <div className="toast" role="status" aria-live="polite">{toast}</div>
      {problem && (
        <div className="stack">
          <ErrorState title={problem.title}>
            {problem.text}
            {problem.requestId && <small className="notice__code"> Código: {problem.requestId}</small>}
          </ErrorState>
        </div>
      )}

      {list.loading && <Skeleton lines={5} label="Carregando monitores" />}
      {!list.loading && !monitors && list.error && !(list.error instanceof ApiError && list.error.status === 401) && (
        <ErrorState title={describeError(list.error).title} onRetry={list.refetch}>{describeError(list.error).text}</ErrorState>
      )}
      {monitors && list.error && !(list.error instanceof ApiError && list.error.status === 401) && (
        <div className="stack"><Notice tone="warn" title="Não foi possível atualizar a lista">Mostrando a última leitura{list.lastSuccessAt ? `, feita ${formatAgo((now - list.lastSuccessAt) / 1000)}` : ""}. Tentando de novo automaticamente.</Notice></div>
      )}
      {monitors && monitors.length === 0 && (
        <EmptyState title="Você ainda não monitora nada">
          Cadastre o primeiro monitor com o botão “Novo monitor”. A primeira checagem acontece em poucos segundos.
        </EmptyState>
      )}

      {monitors && monitors.length > 0 && (
        <div className="table-wrap">
          <table className="table table--admin" role="table">
            <caption className="sr-only">Monitores cadastrados</caption>
            <thead>
              <tr><th scope="col">Sistema</th><th scope="col">Estado</th><th scope="col">Intervalo</th><th scope="col">Checagens</th><th scope="col"><span className="sr-only">Ações</span></th></tr>
            </thead>
            <tbody>
              {monitors.map((m) => {
                const state = adminState(m);
                const b = busy[m.id];
                return (
                  <tr key={m.id} aria-busy={Boolean(b)}>
                    <td data-label="Sistema"><div className="cell__value">
                      <strong className="cell__name">{m.name}</strong>
                      <span className="cell__url">{m.url}</span>
                    </div></td>
                    <td data-label="Estado"><div className="cell__value">
                      <StateBadge state={state} />
                      {state === "operational" && m.consecutiveFailures > 0 && <small className="cell__sub">{plural(m.consecutiveFailures, "falha recente", "falhas seguidas")}</small>}
                    </div></td>
                    <td data-label="Intervalo"><div className="cell__value">{intervalLabel(m.intervalSeconds)}</div></td>
                    <td data-label="Checagens"><div className="cell__value">
                      {m.lastCheckedAt ? <time dateTime={m.lastCheckedAt} title={formatDateTime(m.lastCheckedAt)}>última {formatAgo((now - Date.parse(m.lastCheckedAt)) / 1000)}</time> : "Nenhuma ainda"}
                      {m.active && <small className="cell__sub">próxima {nextIn(m, now)}</small>}
                    </div></td>
                    <td data-label="Ações"><div className="cell__actions">
                      <button type="button" className="btn btn--small" onClick={() => { setProblem(null); setForm(m); }} disabled={Boolean(b)} aria-label={`Editar ${m.name}`}>Editar</button>
                      {m.active ? (
                        <button type="button" className="btn btn--small" onClick={() => run(m, "pause", `«${m.name}» foi pausado.`)} disabled={Boolean(b)} aria-label={`Pausar ${m.name}`}>{b === "pause" ? "Pausando…" : "Pausar"}</button>
                      ) : (
                        <button type="button" className="btn btn--small" onClick={() => run(m, "resume", `«${m.name}» foi retomado.`)} disabled={Boolean(b)} aria-label={`Retomar ${m.name}`}>{b === "resume" ? "Retomando…" : "Retomar"}</button>
                      )}
                      <button type="button" className="btn btn--small btn--danger" onClick={() => { setProblem(null); setToDelete(m); }} disabled={Boolean(b)} aria-label={`Excluir ${m.name}`}>Excluir</button>
                      </div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
              <button type="button" className="btn btn--quiet" data-autofocus onClick={() => setToDelete(null)} disabled={deleting}>Cancelar</button>
              <button type="button" className="btn btn--danger-solid" onClick={confirmDelete} disabled={deleting}>{deleting ? "Excluindo…" : "Excluir monitor"}</button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

function nextIn(m: AdminMonitor, nowMs: number): string {
  const secs = Math.round((Date.parse(m.nextCheckAt) - nowMs) / 1000);
  return secs <= 0 ? "em instantes" : `em ${formatDuration(secs)}`;
}

function count(ms: AdminMonitor[]) {
  const c = { operational: 0, unavailable: 0, paused: 0, no_data: 0 };
  for (const m of ms) c[adminState(m)]++;
  return c;
}

function summaryText(c: ReturnType<typeof count>, total: number) {
  const parts = [
    c.operational && plural(c.operational, "operacional", "operacionais"),
    c.unavailable && plural(c.unavailable, "indisponível", "indisponíveis"),
    c.paused && plural(c.paused, "pausado", "pausados"),
    c.no_data && `${c.no_data} sem dados`,
  ].filter(Boolean);
  return `${plural(total, "monitor", "monitores")}: ${parts.join(", ")}.`;
}
