import type { ReactNode } from "react";

export function Skeleton({ lines = 3, label = "Carregando" }: { lines?: number; label?: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton__line" style={{ width: `${92 - i * 14}%` }} />
      ))}
    </div>
  );
}

type NoticeTone = "info" | "warn" | "error" | "ok";

/** Aviso inline. `error` é anunciado na hora (role=alert); os demais são educados (role=status). */
export function Notice({ tone = "info", title, children, action }: { tone?: NoticeTone; title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`notice notice--${tone}`} role={tone === "error" ? "alert" : "status"}>
      <div className="notice__body">
        {title && <strong className="notice__title">{title}</strong>}
        {children && <div className="notice__text">{children}</div>}
      </div>
      {action && <div className="notice__action">{action}</div>}
    </div>
  );
}

export function ErrorState({ title, children, onRetry, retryLabel = "Tentar de novo" }: { title: string; children?: ReactNode; onRetry?: () => void; retryLabel?: string }) {
  return (
    <Notice
      tone="error"
      title={title}
      action={onRetry && <button type="button" className="btn btn--quiet" onClick={onRetry}>{retryLabel}</button>}
    >
      {children}
    </Notice>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {children && <p className="empty__text">{children}</p>}
    </div>
  );
}
