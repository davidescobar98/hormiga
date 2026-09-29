import { useState } from 'react';
import { api, toApiError, useInvalidate, useQuery } from '../api';
import { useNavigate } from '../App';
import { addMonths, lastDayOfMonth, todayIso } from '../../../shared/dates';
import { CATEGORY_KINDS, CATEGORY_KIND_LABELS, type CategoryKind } from '../../../shared/types';
import { Card, ErrorBox, Field, Loading, Money, Segmented, useToast } from '../components/ui';

type Range = '3' | '12' | 'all';
const PALETTE = ['#2f8f6b', '#3b82b8', '#d9822b', '#7b61c4', '#b5559b', '#1f9aa8', '#c2647a', '#8aa33a', '#58809a', '#a0784a'];

export function CategoriesPage() {
  const [range, setRange] = useState<Range>('3');
  const currentMonth = todayIso().slice(0, 7);
  const bounds = range === 'all' ? undefined : { from: `${addMonths(currentMonth, -(Number(range) - 1))}-01`, to: lastDayOfMonth(currentMonth) };
  const cats = useQuery(() => api('categories.list', bounds), [range]);
  const rules = useQuery(() => api('rules.list'), []);
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const toast = useToast();
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<CategoryKind>('discretionary');
  const [editing, setEditing] = useState<{ id: number; name: string; color: string } | null>(null);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast({ tone: 'info', message: ok });
      invalidate();
    } catch (err) {
      toast({ tone: 'error', message: toApiError(err).message });
    }
  };

  const spendingCats = (cats.data ?? []).filter((c) => !c.excludedFromSpending);
  const total = spendingCats.reduce((a, c) => a + c.spentCents, 0);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Categorías</h1>
          <p className="subtitle">Marca cada categoría como esencial, discrecional o neutral: se usa para estimar tu capacidad de ahorro.</p>
        </div>
        <Segmented label="Periodo" value={range} onChange={setRange} options={[{ value: '3', label: 'Últimos 3 meses' }, { value: '12', label: '12 meses' }, { value: 'all', label: 'Todo' }]} />
      </div>

      {cats.error && <ErrorBox error={cats.error} onRetry={cats.reload} />}
      <Card title="Gasto por categoría" hint="Gasto neto del periodo (cargos − devoluciones)" actions={total ? <strong><Money cents={total} /></strong> : undefined}>
        {!cats.data ? <Loading /> : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Categoría</th><th>Tipo de gasto</th><th className="right">Movimientos</th><th className="right">Reglas</th><th className="right">Gasto neto</th><th /></tr>
              </thead>
              <tbody>
                {cats.data.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {editing?.id === c.id ? (
                        <div className="row" style={{ flexWrap: 'nowrap' }}>
                          <input type="color" aria-label="Color" value={editing.color} onChange={(e) => setEditing({ ...editing, color: e.target.value })} />
                          <input className="input compact" aria-label="Nombre" value={editing.name} disabled={c.isSystem} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={40} />
                          <button className="btn sm primary" onClick={() => run(() => api('categories.update', { id: c.id, color: editing.color, ...(c.isSystem ? {} : { name: editing.name }) }), 'Categoría actualizada.').then(() => setEditing(null))}>Guardar</button>
                          <button className="btn sm ghost" onClick={() => setEditing(null)}>Cancelar</button>
                        </div>
                      ) : (
                        <span className="row" style={{ gap: 8 }}>
                          <span className="dot" style={{ background: c.color }} aria-hidden />
                          <span className="cell-main">{c.name}</span>
                          {!c.isSystem && <span className="badge outline">Personalizada</span>}
                          {c.excludedFromSpending && <span className="badge">No cuenta como gasto</span>}
                        </span>
                      )}
                    </td>
                    <td>
                      <select className="select compact" aria-label={`Tipo de gasto de ${c.name}`} value={c.kind} disabled={c.excludedFromSpending} onChange={(e) => run(() => api('categories.update', { id: c.id, kind: e.target.value as CategoryKind }))}>
                        {CATEGORY_KINDS.map((k) => <option key={k} value={k}>{CATEGORY_KIND_LABELS[k]}</option>)}
                      </select>
                    </td>
                    <td className="right num">{c.txCount}</td>
                    <td className="right num">{c.ruleCount}</td>
                    <td className="right">{c.excludedFromSpending ? <span className="muted">—</span> : <Money cents={c.spentCents} />}</td>
                    <td className="right">
                      <button className="btn sm ghost" onClick={() => navigate('transactions', { categoryId: c.id, ...(bounds ?? {}) })}>Ver movimientos</button>
                      <button className="btn sm ghost" onClick={() => setEditing({ id: c.id, name: c.name, color: c.color })}>Editar</button>
                      {!c.isSystem && (
                        <button className="btn sm ghost" onClick={() => { if (confirm(`¿Eliminar la categoría «${c.name}»? Sus movimientos pasarán a «Sin clasificar».`)) void run(() => api('categories.delete', { id: c.id }), 'Categoría eliminada.'); }}>Eliminar</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid grid-2">
        <Card title="Nueva categoría">
          <div className="stack">
            <div className="form-row">
              <Field label="Nombre" htmlFor="cat-name">
                <input id="cat-name" className="input" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={40} placeholder="Mascotas" />
              </Field>
              <Field label="Tipo de gasto" htmlFor="cat-kind">
                <select id="cat-kind" className="select" value={newKind} onChange={(e) => setNewKind(e.target.value as CategoryKind)}>
                  {CATEGORY_KINDS.map((k) => <option key={k} value={k}>{CATEGORY_KIND_LABELS[k]}</option>)}
                </select>
              </Field>
            </div>
            <div>
              <button className="btn primary" disabled={!newName.trim()} onClick={() => run(() => api('categories.create', { name: newName.trim(), kind: newKind, color: PALETTE[(cats.data?.length ?? 0) % PALETTE.length]! }), 'Categoría creada.').then(() => setNewName(''))}>Crear categoría</button>
            </div>
            <p className="muted small">Esencial: difícil de reducir (vivienda, supermercado). Discrecional: reducible (restaurantes, ocio). Neutral: no se evalúa.</p>
          </div>
        </Card>
        <Card title="Reglas" hint="Creadas a partir de tus correcciones. Tienen prioridad sobre las reglas integradas.">
          {!rules.data ? <Loading /> : rules.data.length === 0 ? (
            <p className="muted">Todavía no hay reglas. Cuando cambies la categoría de un movimiento, Hormiga te ofrecerá aplicarla siempre a ese comercio.</p>
          ) : (
            <table className="table">
              <thead><tr><th>Condición</th><th>Categoría</th><th className="right">Aplicada a</th><th /></tr></thead>
              <tbody>
                {rules.data.map((r) => (
                  <tr key={r.id}>
                    <td>{r.displayPattern}</td>
                    <td>{r.categoryName}</td>
                    <td className="right num">{r.matchCount}</td>
                    <td className="right"><button className="btn sm ghost" onClick={() => run(() => api('rules.delete', { id: r.id }), 'Regla eliminada; los movimientos afectados se han reclasificado.')}>Eliminar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}
