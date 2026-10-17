import { useState, type ReactNode } from 'react';
import { formatDistanceToNow } from 'date-fns';

export const ago = (value?: string | null) => (value ? formatDistanceToNow(new Date(value), { addSuffix: true }) : 'never');

export function Chip({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info'; children: ReactNode }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch${checked ? ' on' : ''}`} onClick={() => onChange(!checked)}><i /></button>;
}

export function PageHead({ eyebrow, title, children, actions }: { eyebrow: string; title: string; children?: ReactNode; actions?: ReactNode }) {
  return <header className="page-head"><div><span className="eyebrow-tag">{eyebrow}</span><h1>{title}</h1>{children && <p>{children}</p>}</div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

export function Notice({ tone = 'info', title, children, action }: { tone?: 'info' | 'warn' | 'bad' | 'good'; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className={`notice ${tone}`} role={tone === 'bad' ? 'alert' : 'status'}><div><strong>{title}</strong>{children && <span>{children}</span>}</div>{action}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty-block"><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}

/** Two-step button that replaces window.confirm so destructive actions stay inside the interface. */
export function ConfirmButton({ label, confirmLabel = 'Confirm', onConfirm, tone = 'danger', disabled }: { label: ReactNode; confirmLabel?: string; onConfirm: () => void | Promise<void>; tone?: 'danger' | 'plain'; disabled?: boolean }) {
  const [armed, setArmed] = useState(false);
  if (!armed) return <button type="button" className={`btn ${tone}`} disabled={disabled} onClick={() => setArmed(true)}>{label}</button>;
  return <span className="confirm-pair"><button type="button" className={`btn ${tone} armed`} onClick={() => { setArmed(false); void onConfirm(); }}>{confirmLabel}</button><button type="button" className="btn plain" onClick={() => setArmed(false)}>Cancel</button></span>;
}

export function ErrorLine({ message, action }: { message?: string; action?: string }) {
  if (!message) return null;
  return <p className="error-line" role="alert">{message}{action ? <span> {action}</span> : null}</p>;
}
