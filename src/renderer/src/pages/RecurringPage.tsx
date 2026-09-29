import { api, toApiError, useInvalidate, useQuery } from '../api';
import { useNavigate } from '../App';
import { formatDate } from '../../../shared/dates';
import { formatCents } from '../../../shared/money';
import { FREQUENCY_LABELS, RECURRING_STATUS_LABELS, type RecurringDTO, type RecurringStatus } from '../../../shared/types';
import { Badge, Card, EmptyState, ErrorBox, Loading, Money, useToast } from '../components/ui';

export function RecurringPage() {
  const q = useQuery(() => api('recurring.list'), []);
  const invalidate = useInvalidate();
  const toast = useToast();
  const navigate = useNavigate();

  const setStatus = async (r: RecurringDTO, status: RecurringStatus) => {
    try {
      await api('recurring.setStatus', { id: r.id, status });
      invalidate();
    } catch (err) {
      toast({ tone: 'error', message: toApiError(err).message });
    }
  };

  const active = (q.data ?? []).filter((r) => r.status !== 'dismissed');
  const dismissed = (q.data ?? []).filter((r) => r.status === 'dismissed');
  const monthly = active.reduce((a, r) => a + r.monthlyCents, 0);
  const subs = active.filter((r) => r.kind === 'subscription');

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Gastos recurrentes</h1>
          <p className="subtitle">Suscripciones, recibos y cuotas detectados por comercio, importe y periodicidad.</p>
        </div>
        <button className="btn" onClick={async () => { await api('recurring.redetect'); invalidate(); toast({ tone: 'info', message: 'Detección actualizada.' }); }}>Volver a detectar</button>
      </div>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {!q.data ? <Loading /> : q.data.length === 0 ? (
        <Card>
          <EmptyState title="No se han detectado gastos recurrentes" icon="repeat">
            Se necesitan al menos 3 cargos del mismo comercio con importe estable y periodicidad regular (2 para cargos anuales de seguros o suscripciones). Con más meses de histórico aparecerán aquí.
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="grid grid-3">
            <Card><div className="stat-card"><span className="stat-label">Coste mensual equivalente</span><span className="stat-value"><Money cents={monthly} /></span><span className="stat-sub">{active.length} gastos activos</span></div></Card>
            <Card><div className="stat-card"><span className="stat-label">Coste anual estimado</span><span className="stat-value"><Money cents={monthly * 12} /></span><span className="stat-sub">Si se mantienen los importes</span></div></Card>
            <Card><div className="stat-card"><span className="stat-label">Suscripciones</span><span className="stat-value num">{subs.length}</span><span className="stat-sub">{formatCents(subs.reduce((a, r) => a + r.monthlyCents, 0))}/mes</span></div></Card>
          </div>
          <Card title="Detectados" hint="Confirma los que sean correctos; descarta los que no sean recurrentes.">
            <RecurringTable items={active} onStatus={setStatus} onOpen={(r) => navigate('transactions', { merchantId: r.merchantId })} />
          </Card>
          {dismissed.length > 0 && (
            <Card title="Descartados" hint="No cuentan como gasto fijo.">
              <RecurringTable items={dismissed} onStatus={setStatus} onOpen={(r) => navigate('transactions', { merchantId: r.merchantId })} />
            </Card>
          )}
        </>
      )}
    </div>
  );
}

const SHORT_STATUS: Record<RecurringStatus, string> = { probable: 'Probable', confirmed: 'Confirmado', dismissed: 'No recurrente' };

function RecurringTable({ items, onStatus, onOpen }: { items: RecurringDTO[]; onStatus: (r: RecurringDTO, s: RecurringStatus) => void; onOpen: (r: RecurringDTO) => void }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Comercio</th><th>Categoría</th><th>Frecuencia</th><th>Próximo cargo (estimado)</th>
            <th className="right">Coste mensual eq.</th><th>Estado</th><th><span className="sr-only">Acciones</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id}>
              <td>
                <button className="btn link" style={{ color: 'var(--ink)' }} onClick={() => onOpen(r)}>{r.merchantName}</button>
                <div className="cell-sub" title={r.reason}>{r.occurrences} cargos · último {formatDate(r.lastDate)}</div>
              </td>
              <td>
                {r.categoryName}
                {r.kind === 'subscription' && <div><Badge tone="info">Suscripción</Badge></div>}
              </td>
              <td>
                {FREQUENCY_LABELS[r.frequency]}
                <div className="cell-sub">media <Money cents={r.averageCents} /></div>
              </td>
              <td className="num">{r.status === 'dismissed' ? '—' : formatDate(r.nextDate)}</td>
              <td className="right">
                <Money cents={r.monthlyCents} />
                <div className="cell-sub"><Money cents={r.annualCents} />/año</div>
              </td>
              <td><Badge tone={r.status === 'confirmed' ? 'positive' : r.status === 'probable' ? 'warning' : 'outline'} title={RECURRING_STATUS_LABELS[r.status]}>{SHORT_STATUS[r.status]}</Badge></td>
              <td className="right" style={{ whiteSpace: 'nowrap' }}>
                {r.status !== 'confirmed' && <button className="btn sm" onClick={() => onStatus(r, 'confirmed')}>Confirmar</button>}{' '}
                {r.status !== 'dismissed' && <button className="btn sm ghost" onClick={() => onStatus(r, 'dismissed')}>Descartar</button>}
                {r.status === 'dismissed' && <button className="btn sm ghost" onClick={() => onStatus(r, 'probable')}>Restaurar</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
