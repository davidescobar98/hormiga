import { api, toApiError, useInvalidate, useQuery } from '../api';
import { formatDate } from '../../../shared/dates';
import type { ExtraordinaryMovement } from '../../../shared/types';
import { Card, TxAmount, useToast } from './ui';

/**
 * Very large movements still counted as spending or income. Buying a home or a car, a loan drawdown or a sale change
 * what you own, not how much you save, so they distort every average if they stay as spending/income.
 */
export function ExtraordinaryCard() {
  const q = useQuery(() => api('accounts.extraordinary'), []);
  const invalidate = useInvalidate();
  const toast = useToast();
  const list = q.data ?? [];
  if (!list.length) return null;
  const resolve = async (m: ExtraordinaryMovement, asCapital: boolean) => {
    try {
      await api('accounts.resolveExtraordinary', { id: m.id, asCapital });
      toast({ tone: 'info', message: asCapital ? 'Marcado como operación patrimonial: ya no cuenta como gasto ni ingreso.' : 'De acuerdo, se mantiene.' });
      invalidate();
    } catch (err) {
      toast({ tone: 'error', message: toApiError(err).message });
    }
  };
  return (
    <Card title="Movimientos extraordinarios por revisar" hint="De 10.000 € o más: pueden descuadrar tu ahorro">
      <p className="small">
        Comprar una vivienda o un coche, recibir un préstamo, una venta o una fianza cambian <strong>lo que tienes</strong>, no lo que gastas o ganas cada mes. Si los marcas como
        «Patrimonio y préstamos» dejan de contar en gasto, ingresos y ahorro (puedes registrar el bien y el préstamo en «Patrimonio»). Los impuestos y gastos de la compra (notaría, ITP…) sí son gasto.
      </p>
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {list.slice(0, 8).map((m) => (
              <tr key={m.id}>
                <td className="num">{formatDate(m.date)}</td>
                <td><div className="cell-main">{m.description.split(' · ')[0]}</div><div className="cell-sub">{m.categoryName}</div></td>
                <td className="right"><TxAmount cents={m.amountCents} /></td>
                <td className="right" style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn sm primary" onClick={() => void resolve(m, true)}>Es patrimonio</button>{' '}
                  <button className="btn sm ghost" onClick={() => void resolve(m, false)}>{m.amountCents < 0 ? 'Es un gasto real' : 'Es un ingreso real'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length > 8 && <p className="muted small">Y {list.length - 8} más.</p>}
    </Card>
  );
}
