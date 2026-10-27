import { useState, type FormEvent } from "react";
import { adminApi } from "../../api/endpoints";
import type { AdminMonitor, MonitorInput } from "../../api/types";
import { Notice } from "../../components/feedback";
import { Modal } from "../../components/Modal";
import { describeError, type Described } from "../../lib/errorText";
import { formatDuration } from "../../lib/format";

const PRESETS = [30, 60, 120, 300, 600, 900, 1800, 3600, 21_600, 86_400];

export function intervalLabel(s: number) {
  return s === 60 ? "1 minuto" : `${formatDuration(s)}`.replace(/^(\d+) min$/, (_m, n) => `${n} ${Number(n) === 1 ? "minuto" : "minutos"}`);
}

interface Props {
  /** null = fechado; "new" = cadastro; monitor = edição. */
  target: AdminMonitor | "new" | null;
  onClose: () => void;
  onSaved: (m: AdminMonitor, created: boolean) => void;
  onSessionProblem: (d: Described) => void;
}

export function MonitorFormDialog({ target, onClose, ...rest }: Props) {
  // O formulário só existe com o diálogo aberto; a chave reinicia o estado a cada abertura.
  return (
    <Modal open={target !== null} onClose={onClose} titleId="monitor-form-title">
      {target !== null && <FormBody key={target === "new" ? "new" : target.id} target={target} onClose={onClose} {...rest} />}
    </Modal>
  );
}

function FormBody({ target, onClose, onSaved, onSessionProblem }: Omit<Props, "target"> & { target: AdminMonitor | "new" }) {
  const editing = target !== "new" ? target : null;
  const [name, setName] = useState(editing?.name ?? "");
  const [url, setUrl] = useState(editing?.url ?? "https://");
  const [interval, setIntervalSeconds] = useState(editing?.intervalSeconds ?? 60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Described | null>(null);
  const [local, setLocal] = useState<Record<string, string>>({});

  const options = PRESETS.includes(interval) ? PRESETS : [...PRESETS, interval].sort((a, b) => a - b);
  const fieldError = (k: string) => local[k] ?? error?.fields[k];

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const problems: Record<string, string> = {};
    if (!name.trim()) problems.name = "Informe um nome.";
    if (name.trim().length > 100) problems.name = "Use no máximo 100 caracteres.";
    if (!/^https:\/\//i.test(url.trim())) problems.url = "A URL precisa começar com https://.";
    setLocal(problems);
    if (Object.keys(problems).length > 0) return;

    const input: MonitorInput = { name: name.trim(), url: url.trim(), intervalSeconds: interval };
    // Na edição só vai o que mudou (PATCH exige ao menos um campo).
    const patch: Partial<MonitorInput> = editing
      ? Object.fromEntries(Object.entries(input).filter(([k, v]) => (editing as unknown as Record<string, unknown>)[k] !== v))
      : input;
    if (editing && Object.keys(patch).length === 0) return onClose();

    setBusy(true);
    setError(null);
    try {
      const saved = editing ? await adminApi.update(editing.id, patch) : await adminApi.create(input);
      onSaved(saved, !editing);
    } catch (err) {
      const d = describeError(err);
      if (d.unauthenticated || d.csrf) onSessionProblem(d);
      else setError(d);
    } finally {
      setBusy(false);
    }
  };

  const invalidCount = Object.keys(local).length + Object.keys(error?.fields ?? {}).length;

  return (
    <form onSubmit={onSubmit} className="form modal__body" noValidate>
      <h2 id="monitor-form-title" className="modal__title">{editing ? "Editar monitor" : "Novo monitor"}</h2>
      {error && (
        <Notice tone="error" title={error.title}>
          {error.text}
          {error.general.length > 0 && <ul className="notice__list">{error.general.map((g) => <li key={g}>{g}</li>)}</ul>}
          {error.requestId && <small className="notice__code"> Código: {error.requestId}</small>}
        </Notice>
      )}
      {invalidCount > 0 && !error && <Notice tone="error" title="Revise os campos indicados" />}

      <div className="field">
        <label htmlFor="mf-name">Nome</label>
        <input id="mf-name" value={name} maxLength={100} data-autofocus onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(fieldError("name"))} aria-describedby={fieldError("name") ? "mf-name-err" : undefined} />
        {fieldError("name") && <p id="mf-name-err" className="field__error">{fieldError("name")}</p>}
        <p className="field__hint">Aparece na página pública de status.</p>
      </div>
      <div className="field">
        <label htmlFor="mf-url">URL a monitorar</label>
        <input id="mf-url" type="text" inputMode="url" spellCheck={false} autoCapitalize="none" value={url} onChange={(e) => setUrl(e.target.value)} aria-invalid={Boolean(fieldError("url"))} aria-describedby={`mf-url-hint${fieldError("url") ? " mf-url-err" : ""}`} />
        {fieldError("url") && <p id="mf-url-err" className="field__error">{fieldError("url")}</p>}
        <p id="mf-url-hint" className="field__hint">Somente HTTPS. A URL só aparece aqui, nunca na página pública. Endereços internos (localhost, redes privadas) são recusados.</p>
      </div>
      <div className="field">
        <label htmlFor="mf-interval">Intervalo entre checagens</label>
        <select id="mf-interval" value={interval} onChange={(e) => setIntervalSeconds(Number(e.target.value))} aria-invalid={Boolean(fieldError("intervalSeconds"))} aria-describedby={fieldError("intervalSeconds") ? "mf-int-err" : undefined}>
          {options.map((s) => <option key={s} value={s}>{intervalLabel(s)}</option>)}
        </select>
        {fieldError("intervalSeconds") && <p id="mf-int-err" className="field__error">{fieldError("intervalSeconds")}</p>}
      </div>

      <div className="modal__actions">
        <button type="button" className="btn btn--quiet" onClick={onClose} disabled={busy}>Cancelar</button>
        <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Salvando…" : editing ? "Salvar alterações" : "Cadastrar monitor"}</button>
      </div>
    </form>
  );
}
