import { useState } from 'react';
import { api, toApiError, useInvalidate, useQuery } from '../api';
import { formatCents } from '../../../shared/money';
import { formatMonth } from '../../../shared/dates';
import type { AlertDTO, BudgetLine } from '../../../shared/types';
import { useNavigate, type PageId } from '../App';
import { Badge, Card, Dialog, EuroInput, Field, Icon, Loading, Money, useToast } from './ui';

const STATUS: Record<BudgetLine['status'], { tone: 'positive' | 'warning' | 'negative' | 'info'; label: string; color: string }> = {
  ok: { tone: 'positive', label: 'En línea', color: 'var(--chart-1)' },
  at_risk: { tone: 'info', label: 'A este ritmo lo superarás', color: 'var(--chart-3)' },
  warning: { tone: 'warning', label: 'Más del 80 %', color: 'var(--warning)' },
  over: { tone: 'negative', label: 'Superado', color: 'var(--negative)' },
};

/** Monthly budgets per category with progress, projection and suggestions from your history. */
export function BudgetsCard() {
  const q = useQuery(() => api('budgets.overview'), []);
  const cats = useQuery(() => api('categories.list'), []);
  const [editing, setEditing] = useState<{ categoryId: number | null; amount: number | null } | null>(null);
  const invalidate = useInvalidate();
  const toast = useToast();
  const b = q.data;

  const save = async (categoryId: number, amountCents: number | null) => {
    try {
      await api('budgets.set', { categoryId, amountCents });
      invalidate();
      q.reload();
      return true;
    } catch (err) {
      toast({ tone: 'error', message: toApiError(err).message });
      return false;
    }
  };

  return (
    <Card
      title="Presupuestos del mes"
      hint={b ? `${formatMonth(b.month)} · límite mensual por categoría` : undefined}
      actions={<button className="btn sm" onClick={() => setEditing({ categoryId: null, amount: null })}>Añadir presupuesto</button>}
    >
      {!b ? <Loading /> : (
        <div className="stack">
          {b.lines.length === 0 ? (
            <p className="muted">Pon un límite a las categorías donde más se te va el dinero y Hormiga te avisará al llegar al 80 % y si lo superas.</p>
          ) : (
            <>
              <div className="bar-list">
                {b.lines.map((l) => {
                  const st = STATUS[l.status];
                  return (
                    <div className="bar-row" key={l.categoryId}>
                      <div className="bar-row-top">
                        <span><button className="btn link" onClick={() => setEditing({ categoryId: l.categoryId, amount: l.limitCents })}>{l.name}</button> <Badge tone={st.tone}>{st.label}</Badge></span>
                        <span><span className="num">{formatCents(l.spentCents)}</span><span className="muted small num"> / {formatCents(l.limitCents)}</span></span>
                      </div>
                      <div className="bar-track" aria-label={`${l.name}: ${Math.round(l.usedBp / 100)} % del presupuesto`}>
                        <div className="bar-fill" style={{ width: `${Math.min(100, l.usedBp / 100)}%`, background: st.color }} />
                      </div>
                      <div className="muted small">
                        {l.remainingCents >= 0 ? `Quedan ${formatCents(l.remainingCents)}` : `${formatCents(-l.remainingCents)} por encima`}
                        {b.isCurrentMonth && l.daysLeft > 0 ? ` · ${l.daysLeft} ${l.daysLeft === 1 ? 'día' : 'días'} · a este ritmo acabarías en ${formatCents(l.projectedCents)}` : ''}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="row small" style={{ justifyContent: 'space-between' }}>
                <span className="muted">Total presupuestado</span>
                <span><Money cents={b.totalSpentCents} /> de <Money cents={b.totalLimitCents} /></span>
              </div>
            </>
          )}
          {b.suggestions.length > 0 && (
            <details open={b.lines.length === 0}>
              <summary>Sugerencias según tus últimos 3 meses</summary>
              <div className="stack" style={{ marginTop: 8 }}>
                {b.suggestions.map((s) => (
                  <div key={s.categoryId} className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="small">{s.name} <span className="muted">· lo habitual: {formatCents(s.averageCents)}/mes</span></span>
                    <button className="btn sm ghost" onClick={async () => { if (await save(s.categoryId, s.suggestedCents)) toast({ tone: 'info', message: `Presupuesto de ${s.name}: ${formatCents(s.suggestedCents)}/mes.` }); }}>
                      Usar {formatCents(s.suggestedCents)}
                    </button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
      {editing && (
        <BudgetDialog
          initial={editing}
          categories={(cats.data ?? []).filter((c) => !c.excludedFromSpending)}
          line={b?.lines.find((l) => l.categoryId === editing.categoryId) ?? null}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </Card>
  );
}

function BudgetDialog({ initial, categories, line, onClose, onSave }: {
  initial: { categoryId: number | null; amount: number | null };
  categories: { id: number; name: string }[];
  line: BudgetLine | null;
  onClose: () => void;
  onSave: (categoryId: number, amount: number | null) => Promise<boolean>;
}) {
  const [categoryId, setCategoryId] = useState<number | null>(initial.categoryId ?? categories[0]?.id ?? null);
  const [amount, setAmount] = useState<number | null>(initial.amount);
  return (
    <Dialog
      open
      title={initial.categoryId ? `Presupuesto de ${line?.name ?? ''}` : 'Nuevo presupuesto'}
      onClose={onClose}
      footer={<>
        {initial.categoryId && <button className="btn danger" onClick={async () => { if (await onSave(initial.categoryId!, null)) onClose(); }}>Quitar</button>}
        <button className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn primary" disabled={!categoryId || !amount} onClick={async () => { if (categoryId && amount && (await onSave(categoryId, amount))) onClose(); }}>Guardar</button>
      </>}
    >
      <div className="form-row">
        {!initial.categoryId && (
          <Field label="Categoría" htmlFor="bd-cat">
            <select id="bd-cat" className="select" value={categoryId ?? ''} onChange={(e) => setCategoryId(Number(e.target.value))}>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Límite al mes" htmlFor="bd-amount" help={line?.averageCents ? `Lo habitual en tus 3 últimos meses completos (mediana): ${formatCents(line.averageCents)}` : undefined}>
          <EuroInput id="bd-amount" valueCents={amount} onChange={setAmount} />
        </Field>
      </div>
    </Dialog>
  );
}

const KIND_ICON: Record<string, string> = {
  budget: 'target', unusual_charge: 'alert', duplicate_charge: 'alert', price_increase: 'up', upcoming_payment: 'repeat', transfer_review: 'info', sync: 'mail',
};

/** Recent alerts (always available in the app, with or without Windows notifications). */
export function AlertsCard() {
  const q = useQuery(() => api('alerts.list'), []);
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const list = q.data ?? [];
  const unread = list.filter((a) => !a.read).length;
  if (q.data && list.length === 0) return null;
  const open = async (a: AlertDTO) => {
    await api('alerts.markRead', { key: a.key });
    invalidate();
    navigate(a.page as PageId, a.section ? { section: a.section } : {});
  };
  return (
    <Card title={unread ? `Avisos (${unread} nuevos)` : 'Avisos'} actions={unread ? <button className="btn sm ghost" onClick={async () => { await api('alerts.markRead'); invalidate(); }}>Marcar como leídos</button> : undefined}>
      {!q.data ? <Loading /> : (
        <ul className="alert-list">
          {list.slice(0, 6).map((a) => (
            <li key={a.key} className={a.read ? 'read' : ''}>
              <button className="alert-item" onClick={() => void open(a)}>
                <Icon name={KIND_ICON[a.kind] ?? 'info'} size={16} />
                <span>
                  <strong>{a.title}</strong>
                  <span className="muted small">{a.body}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
