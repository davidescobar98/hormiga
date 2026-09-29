import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { formatBp, formatCents, parseAmountToCents } from '../../../shared/money';
import { formatMonth } from '../../../shared/dates';
import type { ApiError } from '../api';

// ───────── Icons (inline, no external assets) ─────────
const PATHS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  tag: 'M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01',
  repeat: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
  chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  piggy: 'M19 9c1 0 2 1 2 2v2h-2l-1 3h-2v2h-3v-2H9v2H6v-2.5A6 6 0 0 1 4 9a5 5 0 0 1 5-4h4a6 6 0 0 1 6 4zM15.5 9.5h.01',
  file: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M9 13h6M9 17h6',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M19 12l-7 7-7-7',
  flat: 'M5 12h14',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  target: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  briefcase: 'M3 7h18v13H3zM8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18',
  sparkle: 'M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8',
};

export function Icon({ name, size = 18, label }: { name: keyof typeof PATHS | string; size?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d={PATHS[name] ?? PATHS.info} />
    </svg>
  );
}

// ───────── Money & figures ─────────
export function Money({ cents, signed, compact, className }: { cents: number | null | undefined; signed?: boolean; compact?: boolean; className?: string }) {
  if (cents === null || cents === undefined) return <span className={`num muted ${className ?? ''}`}>—</span>;
  return <span className={`num ${className ?? ''}`}>{formatCents(cents, { signed, compact })}</span>;
}

/** Signed amount of a movement: money in shown with "+" and positive colour, money out plain. */
export function TxAmount({ cents }: { cents: number }) {
  return <span className={`num ${cents > 0 ? 'amount-in' : ''}`}>{formatCents(cents, { signed: true })}</span>;
}

/**
 * Change indicator. For spending, "up" is bad; for savings, "up" is good (`higherIsBetter`).
 * The arrow and the words carry the meaning; colour only reinforces it.
 */
export function Delta({ deltaCents, deltaBp, higherIsBetter = false, reliable = true, label }: { deltaCents: number; deltaBp: number | null; higherIsBetter?: boolean; reliable?: boolean; label?: string }) {
  const dir = deltaCents > 0 ? 'up' : deltaCents < 0 ? 'down' : 'flat';
  const good = dir === 'flat' ? null : (dir === 'up') === higherIsBetter;
  const cls = !reliable ? 'unreliable' : good === null ? '' : good ? 'good' : 'bad';
  const words = dir === 'up' ? 'más' : dir === 'down' ? 'menos' : 'igual';
  return (
    <span className={`delta ${cls}`} title={reliable ? undefined : 'Comparación orientativa: el periodo actual está incompleto'}>
      <Icon name={dir} size={13} />
      <span className="num">{deltaBp !== null ? formatBp(Math.abs(deltaBp), 0) : formatCents(Math.abs(deltaCents))}</span>
      <span>{words}{label ? ` que ${label}` : ''}</span>
    </span>
  );
}

export function Badge({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'positive' | 'negative' | 'warning' | 'info' | 'accent' | 'outline'; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function CategoryTag({ name, color }: { name: string; color: string }) {
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      <span className="dot" style={{ background: color }} aria-hidden />
      <span>{name}</span>
    </span>
  );
}

export function Card({ title, hint, actions, children, className }: { title?: ReactNode; hint?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <div className="card-header">
          <div>
            {title && <h2>{title}</h2>}
            {hint && <div className="hint">{hint}</div>}
          </div>
          {actions && <div className="toolbar">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ title, children, actions, icon = 'file' }: { title: string; children?: ReactNode; actions?: ReactNode; icon?: string }) {
  return (
    <div className="empty">
      <Icon name={icon} size={30} />
      <h2>{title}</h2>
      {children && <p style={{ maxWidth: 520 }}>{children}</p>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Loading({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="loading-block" role="status">
      <span className="spinner" aria-hidden /> {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div className="callout danger" role="alert">
      <span className="icon"><Icon name="alert" /></span>
      <div className="stack" style={{ gap: 6 }}>
        <span>{error.message}</span>
        {onRetry && (
          <span>
            <button className="btn sm" onClick={onRetry}>Reintentar</button>
          </span>
        )}
      </div>
    </div>
  );
}

export function Callout({ tone = 'info', children, icon }: { tone?: 'info' | 'warning' | 'danger' | 'success'; children: ReactNode; icon?: string }) {
  return (
    <div className={`callout ${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <span className="icon"><Icon name={icon ?? (tone === 'success' ? 'check' : tone === 'info' ? 'info' : 'alert')} /></span>
      <div>{children}</div>
    </div>
  );
}

// ───────── Dialog (native <dialog>: focus trap + Esc handled by the browser) ─────────
export function Dialog({ open, title, onClose, children, footer, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
      // Native dialogs focus the first button (the close "X"); prefer the first form field.
      d.querySelector<HTMLElement>('.modal-body input:not([type=checkbox]), .modal-body select, .modal-body textarea')?.focus();
    } else if (!open && d.open) {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    }
  }, [open]);
  if (!open) return null;
  return (
    <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} aria-labelledby={titleId} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="modal-head">
        <h2 id={titleId}>{title}</h2>
        <button className="btn ghost sm" onClick={onClose} aria-label="Cerrar"><Icon name="x" /></button>
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </dialog>
  );
}

// ───────── Toasts ─────────
interface Toast {
  id: number;
  tone: 'info' | 'error';
  message: string;
}
const ToastContext = createContext<(t: Omit<Toast, 'id'>) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), t.tone === 'error' ? 9000 : 5000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone === 'error' ? 'error' : ''}`}>
            <Icon name={t.tone === 'error' ? 'alert' : 'check'} />
            <span>{t.message}</span>
            <button onClick={() => setToasts((l) => l.filter((x) => x.id !== t.id))} aria-label="Cerrar aviso"><Icon name="x" size={14} /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ───────── Form helpers ─────────
export function Field({ label, help, error, children, htmlFor }: { label: string; help?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {help && <div className="help">{help}</div>}
      {error && <div className="error" role="alert">{error}</div>}
    </div>
  );
}

/** Euro amount input: user types "1.234,56"; value is integer cents (never floats). */
export function EuroInput({ id, valueCents, onChange, placeholder, ariaLabel }: { id?: string; valueCents: number | null; onChange: (cents: number | null) => void; placeholder?: string; ariaLabel?: string }) {
  const [text, setText] = useState(valueCents === null ? '' : centsToInput(valueCents));
  const lastExternal = useRef(valueCents);
  useEffect(() => {
    if (valueCents !== lastExternal.current) {
      lastExternal.current = valueCents;
      setText(valueCents === null ? '' : centsToInput(valueCents));
    }
  }, [valueCents]);
  return (
    <div className="euro-input">
      <input
        id={id}
        className="input num"
        inputMode="decimal"
        value={text}
        placeholder={placeholder ?? '0,00'}
        aria-label={ariaLabel}
        onChange={(e) => {
          setText(e.target.value);
          const cents = e.target.value.trim() === '' ? null : parseAmountToCents(e.target.value);
          lastExternal.current = cents;
          onChange(cents);
        }}
      />
    </div>
  );
}

export function centsToInput(cents: number): string {
  const abs = Math.abs(cents);
  const s = `${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
  return cents < 0 ? `-${s}` : s;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function MonthSelect({ value, months, onChange, label = 'Mes' }: { value: string; months: string[]; onChange: (m: string) => void; label?: string }) {
  const list = months.includes(value) ? months : [...months, value].sort();
  return (
    <select className="select compact" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {[...list].reverse().map((m) => (
        <option key={m} value={m}>
          {capitalize(formatMonth(m))}
        </option>
      ))}
    </select>
  );
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function ProgressBar({ valueBp, label }: { valueBp: number | null; label: string }) {
  const pct = valueBp === null ? 0 : Math.max(0, Math.min(100, valueBp / 100));
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
