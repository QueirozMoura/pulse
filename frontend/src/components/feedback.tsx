import { CircleCheck, Info, OctagonAlert, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

export function Skeleton({ lines = 3, label = "Carregando" }: { lines?: number; label?: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton__line" style={{ width: `${94 - i * 13}%` }} />
      ))}
    </div>
  );
}

/** Esqueleto com a silhueta real dos cards: o layout não "pula" quando os dados chegam. */
export function SkeletonUnits({ count = 4, label = "Carregando sistemas" }: { count?: number; label?: string }) {
  return (
    <div className="units" role="status" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="unit unit--skeleton" style={{ animationDelay: `${i * 90}ms` }}>
          <span className="skeleton__line skeleton__line--title" />
          <span className="skeleton__line skeleton__line--num" />
          <span className="skeleton__line" style={{ width: "82%" }} />
          <span className="skeleton__line" style={{ width: "64%" }} />
        </div>
      ))}
    </div>
  );
}

type NoticeTone = "info" | "warn" | "error" | "ok";
const ICON = { info: Info, warn: TriangleAlert, error: OctagonAlert, ok: CircleCheck } as const;

/** Aviso inline. `error` é anunciado na hora (role=alert); os demais são educados (role=status). */
export function Notice({ tone = "info", title, children, action }: { tone?: NoticeTone; title?: string; children?: ReactNode; action?: ReactNode }) {
  const Icon = ICON[tone];
  return (
    <div className={`notice notice--${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon className="notice__icon" size={20} aria-hidden="true" />
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
      action={onRetry && <button type="button" className="btn btn--ghost btn--sm" onClick={onRetry}>{retryLabel}</button>}
    >
      {children}
    </Notice>
  );
}

/** Ilustração do vazio: a linha reta de um sistema ainda sem sinal. */
function FlatlineArt() {
  return (
    <svg className="empty__art" viewBox="0 0 240 64" aria-hidden="true" focusable="false">
      <path d="M4 32h66" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" fill="none" opacity="0.5" />
      <path d="M82 32h154" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeDasharray="1 9" fill="none" opacity="0.5" />
      <circle cx="76" cy="32" r="5" fill="none" stroke="var(--ice)" strokeWidth="2" />
      <circle cx="76" cy="32" r="11" fill="none" stroke="var(--ice)" strokeWidth="1" opacity="0.35" />
    </svg>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <FlatlineArt />
      <p className="empty__title">{title}</p>
      {children && <p className="empty__text">{children}</p>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}
