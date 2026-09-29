import { useEffect, useState } from 'react';
import { api, toApiError, useInvalidate, useQuery } from '../api';
import type { NavParams } from '../App';
import { formatDate } from '../../../shared/dates';
import { formatCents } from '../../../shared/money';
import {
  CLASSIFICATION_SOURCE_LABELS, RECURRING_STATUS_LABELS, TRANSACTION_TYPES, TRANSACTION_TYPE_LABELS, type Category,
  type RuleSuggestion, type TransactionDTO, type TransactionQuery, type TransactionSort, type TransactionType,
  type UpdateTransactionInput,
} from '../../../shared/types';
import { Badge, Callout, Card, CategoryTag, Dialog, EmptyState, ErrorBox, Field, Icon, Loading, TxAmount, useToast } from '../components/ui';
import { ImportButton } from '../components/flows';

const PAGE = 100;

export function TransactionsPage({ initial }: { initial: NavParams }) {
  const [query, setQuery] = useState<TransactionQuery>({
    sort: 'date',
    dir: 'desc',
    limit: PAGE,
    offset: 0,
    categoryId: initial.categoryId,
    uncategorizedOnly: initial.uncategorizedOnly,
    merchantId: initial.merchantId,
    accountId: initial.accountId,
    from: initial.from,
    to: initial.to,
  });
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery((q) => ({ ...q, search: search || undefined, offset: 0 })), 250);
    return () => clearTimeout(t);
  }, [search]);

  const page = useQuery(() => api('transactions.list', query), [JSON.stringify(query)]);
  const categories = useQuery(() => api('categories.list'), []);
  const accounts = useQuery(() => api('accounts.list'), []);
  const [openId, setOpenId] = useState<number | null>(null);
  const [suggestion, setSuggestion] = useState<RuleSuggestion | null>(null);
  const invalidate = useInvalidate();
  const toast = useToast();

  const setSort = (sort: TransactionSort) =>
    setQuery((q) => ({ ...q, sort, dir: q.sort === sort && q.dir === 'desc' ? 'asc' : 'desc', offset: 0 }));

  const changeCategory = async (t: TransactionDTO, categoryId: number) => {
    try {
      const r = await api('transactions.update', { id: t.id, categoryId });
      invalidate();
      if (r.ruleSuggestion) setSuggestion(r.ruleSuggestion);
    } catch (err) {
      toast({ tone: 'error', message: toApiError(err).message });
    }
  };

  const cats = (categories.data ?? []) as Category[];
  const hasFilters = !!(query.search || query.categoryId || query.type || query.from || query.to || query.uncategorizedOnly || query.merchantId || query.accountId || query.onlyExcluded);
  const sortIndicator = (s: TransactionSort) => (query.sort === s ? (query.dir === 'asc' ? 'ascending' : 'descending') : undefined);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Movimientos</h1>
          <p className="subtitle">
            {page.data ? `${page.data.total.toLocaleString('es-ES')} movimientos · saldo neto ${formatCents(page.data.netCents, { signed: true })}` : ' '}
          </p>
        </div>
        <ImportButton primary={false} />
      </div>

      <Card>
        <div className="toolbar" role="search" style={{ marginBottom: 14 }}>
          <div style={{ position: 'relative', flex: '1 1 240px' }}>
            <input className="input" placeholder="Buscar comercio, concepto o nota" aria-label="Buscar movimientos" value={search} onChange={(e) => setSearch(e.target.value)} style={{ paddingLeft: 32 }} />
            <span style={{ position: 'absolute', left: 9, top: 8, color: 'var(--muted)' }} aria-hidden><Icon name="search" size={16} /></span>
          </div>
          <select className="select compact" aria-label="Filtrar por categoría" value={query.categoryId ?? ''} onChange={(e) => setQuery((q) => ({ ...q, categoryId: e.target.value ? Number(e.target.value) : undefined, offset: 0 }))}>
            <option value="">Todas las categorías</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {(accounts.data?.length ?? 0) > 1 && (
            <select className="select compact" aria-label="Filtrar por cuenta" value={query.accountId ?? ''} onChange={(e) => setQuery((q) => ({ ...q, accountId: e.target.value ? Number(e.target.value) : undefined, offset: 0 }))}>
              <option value="">Todas las cuentas</option>
              {accounts.data!.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          <select className="select compact" aria-label="Filtrar por tipo" value={query.type ?? ''} onChange={(e) => setQuery((q) => ({ ...q, type: (e.target.value || undefined) as TransactionType | undefined, offset: 0 }))}>
            <option value="">Todos los tipos</option>
            {TRANSACTION_TYPES.map((t) => <option key={t} value={t}>{TRANSACTION_TYPE_LABELS[t]}</option>)}
          </select>
          <label className="sr-only" htmlFor="tx-from">Desde</label>
          <input id="tx-from" type="date" className="input compact" value={query.from ?? ''} onChange={(e) => setQuery((q) => ({ ...q, from: e.target.value || undefined, offset: 0 }))} title="Desde" />
          <label className="sr-only" htmlFor="tx-to">Hasta</label>
          <input id="tx-to" type="date" className="input compact" value={query.to ?? ''} onChange={(e) => setQuery((q) => ({ ...q, to: e.target.value || undefined, offset: 0 }))} title="Hasta" />
          <label className="check small"><input type="checkbox" checked={!!query.uncategorizedOnly} onChange={(e) => setQuery((q) => ({ ...q, uncategorizedOnly: e.target.checked || undefined, offset: 0 }))} />Sin clasificar</label>
          <label className="check small"><input type="checkbox" checked={!!query.onlyExcluded} onChange={(e) => setQuery((q) => ({ ...q, onlyExcluded: e.target.checked || undefined, offset: 0 }))} />Excluidos</label>
          {hasFilters && (
            <button className="btn ghost sm" onClick={() => { setSearch(''); setQuery({ sort: 'date', dir: 'desc', limit: PAGE, offset: 0 }); }}>Limpiar filtros</button>
          )}
        </div>

        {page.error && <ErrorBox error={page.error} onRetry={page.reload} />}
        {!page.data ? <Loading /> : page.data.items.length === 0 ? (
          hasFilters ? <EmptyState title="Ningún movimiento coincide con los filtros" icon="search" /> : (
            <EmptyState title="No tienes movimientos todavía" actions={<ImportButton />}>Importa tu primer extracto o conecta Gmail.</EmptyState>
          )
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th aria-sort={sortIndicator('date')}><button className="sort" onClick={() => setSort('date')}>Fecha {query.sort === 'date' && (query.dir === 'asc' ? '↑' : '↓')}</button></th>
                  <th aria-sort={sortIndicator('merchant')}><button className="sort" onClick={() => setSort('merchant')}>Comercio / descripción {query.sort === 'merchant' && (query.dir === 'asc' ? '↑' : '↓')}</button></th>
                  <th aria-sort={sortIndicator('category')}><button className="sort" onClick={() => setSort('category')}>Categoría {query.sort === 'category' && (query.dir === 'asc' ? '↑' : '↓')}</button></th>
                  <th>Origen</th>
                  <th className="right" aria-sort={sortIndicator('amount')}><button className="sort" onClick={() => setSort('amount')}>Importe {query.sort === 'amount' && (query.dir === 'asc' ? '↑' : '↓')}</button></th>
                </tr>
              </thead>
              <tbody>
                {page.data.items.map((t) => (
                  <tr key={t.id} className={`clickable ${t.isExcluded ? 'excluded' : ''}`} onClick={() => setOpenId(t.id)} onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && setOpenId(t.id)} tabIndex={0} aria-label={`Abrir detalle de ${t.merchantName ?? t.descriptionRaw}`}>
                    <td className="num">{formatDate(t.date)}</td>
                    <td>
                      <div className="cell-main">
                        {t.merchantName ?? t.descriptionRaw}
                        {t.isExcluded && <> <Badge tone="outline">Excluido</Badge></>}
                        {t.type !== 'expense' && <> <Badge tone={t.type === 'refund' || t.type === 'income' ? 'positive' : 'neutral'}>{TRANSACTION_TYPE_LABELS[t.type]}</Badge></>}
                      </div>
                      <div className="cell-sub" title={t.descriptionRaw}>{t.descriptionRaw}</div>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <select
                        className="select compact"
                        aria-label={`Categoría de ${t.merchantName ?? t.descriptionRaw}`}
                        value={t.categoryId}
                        onChange={(e) => changeCategory(t, Number(e.target.value))}
                        style={{ maxWidth: 180, borderColor: t.classificationSource === 'UNKNOWN' ? 'var(--warning)' : undefined }}
                      >
                        {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </td>
                    <td>
                      <span className="small muted" title={t.classificationDetail ?? ''}>{CLASSIFICATION_SOURCE_LABELS[t.classificationSource]}</span>
                      {t.accountName && (accounts.data?.length ?? 0) > 1 && <div className="cell-sub">{t.accountName}</div>}
                    </td>
                    <td className="right"><TxAmount cents={t.amountCents} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {page.data && page.data.total > PAGE && (
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
            <span className="muted small">
              {query.offset! + 1}–{Math.min(query.offset! + PAGE, page.data.total)} de {page.data.total}
            </span>
            <div className="row">
              <button className="btn sm" disabled={!query.offset} onClick={() => setQuery((q) => ({ ...q, offset: Math.max(0, q.offset! - PAGE) }))}>Anterior</button>
              <button className="btn sm" disabled={query.offset! + PAGE >= page.data.total} onClick={() => setQuery((q) => ({ ...q, offset: q.offset! + PAGE }))}>Siguiente</button>
            </div>
          </div>
        )}
      </Card>

      {openId !== null && <TransactionDetailDialog id={openId} categories={cats} onClose={() => setOpenId(null)} onSuggestion={setSuggestion} />}
      <RuleSuggestionDialog suggestion={suggestion} onClose={() => setSuggestion(null)} />
    </div>
  );
}

export function RuleSuggestionDialog({ suggestion, onClose }: { suggestion: RuleSuggestion | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidate();
  const toast = useToast();
  if (!suggestion) return null;
  const create = async () => {
    setBusy(true);
    try {
      const r = await api('rules.create', { matchType: 'merchant', pattern: String(suggestion.merchantId), categoryId: suggestion.categoryId, applyToExisting: true });
      toast({ tone: 'info', message: `Regla creada${r.updatedTransactions ? ` y ${r.updatedTransactions} movimiento(s) actualizados` : ''}. Los próximos de ${suggestion.merchantName} irán a ${suggestion.categoryName}.` });
      invalidate();
      onClose();
    } catch (err) {
      toast({ tone: 'error', message: toApiError(err).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title="¿Crear una regla?"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Solo este movimiento</button>
          <button className="btn primary" onClick={create} disabled={busy}>Aplicar siempre</button>
        </>
      }
    >
      <p>
        Aplicar siempre la categoría <strong>{suggestion.categoryName}</strong> a los movimientos de <strong>{suggestion.merchantName}</strong>.
      </p>
      <p className="muted">
        {suggestion.affectedCount > 0
          ? `También se actualizarán ${suggestion.affectedCount} movimiento(s) existentes de este comercio (salvo los que hayas cambiado a mano).`
          : 'Se aplicará a los próximos movimientos de este comercio.'}{' '}
        Puedes borrar la regla en Categorías → Reglas.
      </p>
    </Dialog>
  );
}

function TransactionDetailDialog({ id, categories, onClose, onSuggestion }: { id: number; categories: Category[]; onClose: () => void; onSuggestion: (s: RuleSuggestion) => void }) {
  const q = useQuery(() => api('transactions.get', { id }), [id]);
  const [merchant, setMerchant] = useState<string | null>(null);
  const [applyAll, setApplyAll] = useState(false);
  const [notes, setNotes] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invalidate = useInvalidate();
  const toast = useToast();
  const t = q.data;

  const update = async (patch: Omit<UpdateTransactionInput, 'id'>) => {
    setError(null);
    try {
      const r = await api('transactions.update', { id, ...patch });
      invalidate();
      if (r.ruleSuggestion) onSuggestion(r.ruleSuggestion);
      return true;
    } catch (err) {
      setError(toApiError(err).message);
      return false;
    }
  };

  const saveMerchant = async () => {
    if (!t || merchant === null || !merchant.trim()) return;
    if (applyAll && t.merchantId) {
      try {
        await api('merchants.rename', { merchantId: t.merchantId, name: merchant.trim() });
        invalidate();
        toast({ tone: 'info', message: 'Nombre del comercio actualizado en todos sus movimientos.' });
      } catch (err) {
        setError(toApiError(err).message);
      }
    } else if (await update({ merchantName: merchant.trim() })) {
      toast({ tone: 'info', message: 'Comercio actualizado.' });
    }
    setMerchant(null);
  };

  return (
    <Dialog open title="Detalle del movimiento" onClose={onClose} wide footer={<button className="btn" onClick={onClose}>Cerrar</button>}>
      {!t ? <Loading /> : (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <div className="hero-figure" style={{ fontSize: 30 }}><TxAmount cents={t.amountCents} /></div>
              <div className="muted">{formatDate(t.date)}{t.bookingDate && t.bookingDate !== t.date ? ` · valor ${formatDate(t.bookingDate)}` : ''}</div>
            </div>
            <div className="row">
              <Badge>{TRANSACTION_TYPE_LABELS[t.type]}</Badge>
              {t.recurringStatus && <Badge tone="info">{RECURRING_STATUS_LABELS[t.recurringStatus]}</Badge>}
              {t.isExcluded && <Badge tone="outline">Excluido del análisis</Badge>}
            </div>
          </div>
          {error && <Callout tone="danger">{error}</Callout>}

          <Field label="Descripción original del banco">
            <div className="card flat mono" style={{ padding: '8px 10px' }}>{t.descriptionRaw}</div>
          </Field>

          <div className="form-row">
            <Field label="Comercio normalizado" htmlFor="tx-merchant" help={t.merchantRaw ? `Detectado a partir de: ${t.merchantRaw}` : undefined}>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input id="tx-merchant" className="input" value={merchant ?? t.merchantName ?? ''} onChange={(e) => setMerchant(e.target.value)} maxLength={120} />
                <button className="btn" disabled={merchant === null} onClick={saveMerchant}>Guardar</button>
              </div>
              {merchant !== null && t.merchantId && (
                <label className="check small"><input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} />Renombrar en todos los movimientos de «{t.merchantName}»</label>
              )}
            </Field>
            <Field label="Categoría" htmlFor="tx-cat">
              <select id="tx-cat" className="select" value={t.categoryId} onChange={(e) => update({ categoryId: Number(e.target.value) })}>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Tipo de movimiento" htmlFor="tx-type" help="Una devolución resta del gasto; una transferencia no cuenta como gasto.">
              <select id="tx-type" className="select" value={t.type} onChange={(e) => update({ type: e.target.value as TransactionType })}>
                {TRANSACTION_TYPES.map((ty) => <option key={ty} value={ty}>{TRANSACTION_TYPE_LABELS[ty]}</option>)}
              </select>
            </Field>
          </div>

          <dl className="kv">
            <dt>Clasificación</dt>
            <dd>
              <CategoryTag name={t.categoryName} color={t.categoryColor} /> · {CLASSIFICATION_SOURCE_LABELS[t.classificationSource]}
              {t.classificationSource !== 'USER' && ` (confianza ${Math.round(t.classificationConfidence * 100)} %)`}
              <div className="muted small">{t.classificationDetail}</div>
            </dd>
            <dt>Regla utilizada</dt>
            <dd>{t.rule ? (t.rule.matchType === 'merchant' ? `Regla de comercio «${t.rule.pattern}»` : `Contiene «${t.rule.pattern}»`) : t.categoryLocked ? 'Cambio manual' : 'Reglas integradas'}</dd>
            <dt>Documento de origen</dt>
            <dd>
              {t.document ? (
                <>
                  {t.document.fileName} <span className="muted small">({t.document.source === 'email' ? 'Gmail' : t.document.source === 'demo' ? 'demostración' : 'importación manual'})</span>
                  <div className="muted small">
                    {t.document.periodStart && t.document.periodEnd ? `Periodo ${formatDate(t.document.periodStart)} – ${formatDate(t.document.periodEnd)} · ` : ''}
                    Importado el {new Date(t.document.importedAt).toLocaleDateString('es-ES')}{t.document.parserId ? ` · analizador ${t.document.parserId}` : ''}
                    {t.document.emailSubject ? ` · email «${t.document.emailSubject}»` : ''}
                  </div>
                </>
              ) : '—'}
            </dd>
            <dt>Cuenta</dt>
            <dd>{t.accountName ?? '—'}{t.transferMatchId ? <div className="muted small">Emparejado con el movimiento contrario en tu otra cuenta: no cuenta como gasto ni ingreso.</div> : null}</dd>
            <dt>Recurrencia</dt>
            <dd>{t.recurringStatus ? RECURRING_STATUS_LABELS[t.recurringStatus] : 'No detectado como recurrente'}</dd>
          </dl>

          <Field label="Notas" htmlFor="tx-notes">
            <textarea id="tx-notes" className="textarea" value={notes ?? t.notes ?? ''} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          </Field>
          <div className="row">
            <button className="btn" disabled={notes === null} onClick={async () => { if (await update({ notes: notes ?? null })) { setNotes(null); toast({ tone: 'info', message: 'Nota guardada.' }); } }}>Guardar nota</button>
            <span className="spacer" />
            <label className="check">
              <input type="checkbox" checked={t.isExcluded} onChange={(e) => update({ isExcluded: e.target.checked })} />
              Excluir de estadísticas y análisis
            </label>
          </div>
        </>
      )}
    </Dialog>
  );
}
