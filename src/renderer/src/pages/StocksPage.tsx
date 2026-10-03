import { useEffect, useState } from 'react';
import { api, toApiError, useInvalidate, useQuery } from '../api';
import { formatDate, todayIso } from '../../../shared/dates';
import { formatBp, formatCents } from '../../../shared/money';
import type { MarketQuoteDTO, PositionDTO, StockRulesSettings, StockSignalDTO, StocksOverview, StockTradeInput, WatchItemDTO } from '../../../shared/types';
import { Badge, Callout, Card, Dialog, EmptyState, ErrorBox, EuroInput, Field, Loading, Money, Segmented, useToast } from '../components/ui';

const num = (n: number, digits = 2) => n.toLocaleString('es-ES', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtPrice = (n: number | null, cur: string | null) => (n === null ? '—' : `${num(n, n >= 1000 ? 2 : n >= 1 ? 2 : 4)}${cur ? ` ${cur}` : ''}`);
const fmtQty = (n: number) => n.toLocaleString('es-ES', { maximumFractionDigits: 6 });
const parseNum = (t: string): number | null => {
  // "1.234,56" (Spanish) or "1234.56": with a comma, dots are thousands separators.
  const raw = t.trim();
  const s = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
/** Prices of London stocks come in pence; trades are entered in pounds. */
const tradeCurrencyOf = (cur: string | null) => (!cur ? 'EUR' : cur === 'GBp' || cur === 'GBX' ? 'GBP' : cur.toUpperCase());

const STRENGTH: Record<StockSignalDTO['strength'], { tone: 'positive' | 'warning' | 'neutral' | 'negative' | 'info'; label: string }> = {
  strong: { tone: 'positive', label: 'Fuerte' },
  moderate: { tone: 'info', label: 'Moderada' },
  weak: { tone: 'neutral', label: 'Débil' },
};

export function StocksPage({ initialSection }: { initialSection?: string }) {
  const q = useQuery(() => api('stocks.overview'), []);
  const invalidate = useInvalidate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [trade, setTrade] = useState<Partial<StockTradeInput> | null>(null);
  const [adding, setAdding] = useState(false);
  const loaded = q.data !== undefined;
  useEffect(() => {
    if (initialSection && loaded) setTimeout(() => document.getElementById(initialSection)?.scrollIntoView({ block: 'start' }), 200);
  }, [initialSection, loaded]);

  const refresh = async () => {
    setBusy(true);
    try {
      const r = await api('stocks.refresh', { force: true });
      invalidate();
      toast(r.failed.length
        ? { tone: 'error', message: `Actualizadas ${r.updated}. Fallaron: ${r.failed.map((f) => f.symbol).join(', ')} (${r.failed[0]!.message})` }
        : { tone: 'info', message: `Cotizaciones actualizadas (${r.updated}).` });
    } catch (err) {
      toast({ tone: 'error', message: toApiError(err).message });
    } finally {
      setBusy(false);
    }
  };
  const enable = async () => {
    await api('settings.update', { marketDataEnabled: true });
    invalidate();
  };

  const o = q.data;
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Bolsa</h1>
          <p className="subtitle">Sigue acciones y ETF, recibe avisos cuando se cumplen tus reglas de compra y, si compras, avisos para vender (stop-loss, objetivo de beneficio, cambio de tendencia).</p>
        </div>
        <div className="row">
          {o?.marketEnabled && <button className="btn" disabled={busy} onClick={refresh}>{busy ? 'Actualizando…' : 'Actualizar cotizaciones'}</button>}
          <button className="btn primary" onClick={() => setTrade({ side: 'buy' })}>Registrar operación</button>
        </div>
      </div>
      <Callout tone="info" icon="info">
        <strong>No es asesoramiento financiero.</strong> Las señales son reglas técnicas automáticas (medias móviles, RSI, distancia al máximo, tus límites de pérdida y beneficio) sobre cotizaciones públicas. No conocen las noticias ni las cuentas de la empresa, y el pasado no garantiza el futuro. Decide tú y no inviertas dinero que vayas a necesitar.
      </Callout>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {!o ? <Loading /> : (
        <>
          {!o.marketEnabled && (
            <Callout tone="warning">
              Para seguir cotizaciones hay que activar la consulta de datos de mercado. Solo se envía el símbolo de cada valor a {o.source ?? 'Yahoo Finance'}; tus operaciones e importes no salen de este equipo.{' '}
              <button className="btn sm primary" onClick={enable}>Activar datos de mercado</button>
            </Callout>
          )}
          <Callout tone={o.liquidity.ok ? 'success' : 'warning'} icon="wallet">{o.liquidity.note}</Callout>

          <section id="positions" aria-label="Tu cartera">
            <h2 className="section-title">Tu cartera</h2>
            {o.positions.length === 0 ? (
              <Card><EmptyState title="Aún no tienes acciones registradas" icon="briefcase" actions={<button className="btn primary" onClick={() => setTrade({ side: 'buy' })}>Registrar una compra</button>}>Registra tus compras (con su precio y comisiones) para que Hormiga calcule tu rentabilidad real en euros, el IRPF estimado y te avise cuando toque vender.</EmptyState></Card>
            ) : (
              <>
                <section className="card hero" aria-label="Valor de la cartera">
                  <div className="hero-main">
                    <span className="stat-label">Valor de mercado</span>
                    <span className="hero-figure num">{formatCents(o.portfolio.valueCents)}</span>
                    <span className="muted small">
                      {o.portfolio.positions === 1 ? '1 valor' : `${o.portfolio.positions} valores`}
                      {o.portfolio.pricedPositions < o.portfolio.positions ? ` · ${o.portfolio.positions - o.portfolio.pricedPositions} sin cotización (no incluidos)` : ''}
                    </span>
                  </div>
                  <div className="hero-stats">
                    <div className="hero-stat">
                      <span className="stat-label">Invertido</span>
                      <span className="stat-value"><Money cents={o.portfolio.costCents} /></span>
                      <span className="stat-sub">Comisiones incluidas</span>
                    </div>
                    <div className="hero-stat">
                      <span className="stat-label">Resultado latente</span>
                      <span className={`stat-value num ${o.portfolio.gainCents >= 0 ? 'gain-up' : 'gain-down'}`}>{formatCents(o.portfolio.gainCents, { signed: true })}</span>
                      <span className="stat-sub">{formatBp(o.portfolio.gainBp)} sobre lo invertido</span>
                    </div>
                    <div className="hero-stat">
                      <span className="stat-label">IRPF si vendes todo</span>
                      <span className="stat-value"><Money cents={o.portfolio.estimatedTaxCents} /></span>
                      <span className="stat-sub">Estimación, escala del ahorro</span>
                    </div>
                    <div className="hero-stat">
                      <span className="stat-label">Realizado este año</span>
                      <span className="stat-value"><Money cents={o.portfolio.realizedThisYearCents} signed /></span>
                      <span className="stat-sub">Ventas ya hechas</span>
                    </div>
                  </div>
                </section>
                {o.portfolio.note && <Callout tone="info">{o.portfolio.note}</Callout>}
                <div className="grid grid-2">
                  {o.positions.map((p) => <PositionCard key={p.symbol} p={p} onTrade={(side) => setTrade({ side, symbol: p.symbol, currency: tradeCurrencyOf(p.currency) })} />)}
                </div>
              </>
            )}
          </section>

          <section id="watchlist" aria-label="Lista de seguimiento">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 className="section-title">Oportunidades de compra</h2>
              <button className="btn" disabled={!o.marketEnabled} onClick={() => setAdding(true)}>Seguir un valor</button>
            </div>
            {o.watchlist.length === 0 ? (
              <Card><EmptyState title="No sigues ningún valor" icon="search" actions={o.marketEnabled ? <button className="btn primary" onClick={() => setAdding(true)}>Seguir un valor</button> : undefined}>Añade las acciones o ETF que te interesan. Hormiga revisa sus cotizaciones cada pocas horas y te avisa cuando se cumple alguna señal de compra.</EmptyState></Card>
            ) : (
              <div className="grid grid-2">
                {[...o.watchlist].sort((a, b) => b.signals.length - a.signals.length).map((w) => (
                  <WatchCard key={w.symbol} w={w} onBuy={() => setTrade({ side: 'buy', symbol: w.symbol, currency: tradeCurrencyOf(w.currency), price: w.lastPrice ?? undefined })} />
                ))}
              </div>
            )}
          </section>

          <Realized o={o} />
          <Trades o={o} />
          <RulesCard rules={o.rules} />
          <p className="muted small">
            Datos: {o.source ?? 'sin conexión'}{o.lastRefreshAt ? ` · última actualización ${new Date(o.lastRefreshAt).toLocaleString('es-ES')}` : ''}. Cotizaciones con retraso; los precios de cierre no incluyen dividendos.
          </p>
        </>
      )}
      {adding && <AddWatchDialog onClose={() => setAdding(false)} />}
      {trade && <TradeDialog initial={trade} overview={o ?? null} onClose={() => setTrade(null)} />}
    </div>
  );
}

function Sparkline({ values, up }: { values: number[]; up: boolean }) {
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values);
  const w = 160, h = 36;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((v - min) / (max - min || 1)) * h).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Evolución de los últimos 6 meses">
      <polyline points={pts} fill="none" stroke={up ? 'var(--positive)' : 'var(--negative)'} strokeWidth="1.5" />
    </svg>
  );
}

function Metrics({ x }: { x: WatchItemDTO | PositionDTO }) {
  return (
    <div className="muted small" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
      {x.change1yBp !== null && <span>12 meses: {formatBp(x.change1yBp)}</span>}
      {x.drawdownBp !== null && <span>{x.drawdownBp < 50 ? 'En máximos de 52 semanas' : `${formatBp(x.drawdownBp)} por debajo de su máximo de 52 semanas`}</span>}
      {x.rsi14 !== null && <span title="Índice de fuerza relativa: por debajo de 30 sobreventa, por encima de 70 sobrecompra">RSI {x.rsi14.toFixed(0)}</span>}
      {x.sma200 !== null && x.lastPrice !== null && <span>{x.lastPrice >= x.sma200 ? 'Sobre' : 'Bajo'} su media de 200 sesiones</span>}
    </div>
  );
}

function Signals({ list }: { list: StockSignalDTO[] }) {
  if (!list.length) return null;
  return (
    <ul className="plain-list" style={{ margin: '8px 0 0', padding: 0, listStyle: 'none' }}>
      {list.map((s) => (
        <li key={s.kind} style={{ marginTop: 6 }}>
          <Badge tone={s.side === 'sell' ? (s.strength === 'strong' ? 'negative' : 'warning') : STRENGTH[s.strength].tone}>{s.side === 'buy' ? 'Compra' : 'Venta'} · {STRENGTH[s.strength].label}</Badge>{' '}
          <strong>{s.title}</strong>{s.since ? <span className="muted small"> · desde {formatDate(s.since)}</span> : null}
          <div className="small">{s.detail}</div>
        </li>
      ))}
    </ul>
  );
}

function WatchCard({ w, onBuy }: { w: WatchItemDTO; onBuy: () => void }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const [target, setTarget] = useState(w.targetPrice === null ? '' : String(w.targetPrice).replace('.', ','));
  const saveTarget = async () => {
    const v = parseNum(target);
    if (target.trim() && (v === null || v <= 0)) return toast({ tone: 'error', message: 'Precio objetivo no válido.' });
    try {
      await api('stocks.setTarget', { symbol: w.symbol, targetPrice: v });
      invalidate();
    } catch (err) {
      toast({ tone: 'error', message: toApiError(err).message });
    }
  };
  const remove = async () => {
    await api('stocks.removeWatch', { symbol: w.symbol });
    invalidate();
  };
  const up = w.sparkline.length > 1 && w.sparkline[w.sparkline.length - 1]! >= w.sparkline[0]!;
  return (
    <article className="card" aria-label={w.name}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="cell-main">{w.name}</div>
          <div className="cell-sub">{w.symbol}{w.exchange ? ` · ${w.exchange}` : ''}{w.held ? ' · en tu cartera' : ''}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="stat-value num">{fmtPrice(w.lastPrice, w.currency)}</div>
          {w.lastDate && <div className="muted small">{formatDate(w.lastDate)}</div>}
        </div>
      </div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', margin: '8px 0' }}>
        <Sparkline values={w.sparkline} up={up} />
        {w.signals.length === 0 && <Badge tone="outline">Sin señal ahora</Badge>}
      </div>
      <Metrics x={w} />
      <Signals list={w.signals} />
      {w.warnings.map((t) => <Callout key={t} tone="warning">{t}</Callout>)}
      <div className="row" style={{ marginTop: 10, gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label={`Avísame si baja a (${w.currency ?? ''})`} htmlFor={`t-${w.symbol}`}>
          <input id={`t-${w.symbol}`} className="input" style={{ width: 120 }} inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} onBlur={saveTarget} placeholder="Opcional" />
        </Field>
        <button className="btn sm" onClick={onBuy}>Registrar compra</button>
        <button className="btn sm link" onClick={remove}>Dejar de seguir</button>
      </div>
    </article>
  );
}

function PositionCard({ p, onTrade }: { p: PositionDTO; onTrade: (side: 'buy' | 'sell') => void }) {
  const up = (p.gainCents ?? 0) >= 0;
  const trendUp = p.sparkline.length > 1 && p.sparkline[p.sparkline.length - 1]! >= p.sparkline[0]!;
  return (
    <article className="card" aria-label={p.name}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="cell-main">{p.name}</div>
          <div className="cell-sub">{p.symbol} · {fmtQty(p.shares)} acciones · precio medio {fmtPrice(p.avgPriceNative, p.currency)}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="stat-value num">{p.valueCents === null ? '—' : formatCents(p.valueCents)}</div>
          {p.gainCents !== null && <div className={`small num ${up ? 'gain-up' : 'gain-down'}`}>{formatCents(p.gainCents, { signed: true })} ({formatBp(p.gainBp)})</div>}
        </div>
      </div>
      <div className="muted small" style={{ marginTop: 6 }}>
        Invertido {formatCents(p.costCents)} (comisiones incluidas) · Cotización {fmtPrice(p.lastPrice, p.currency)}{p.lastDate ? ` (${formatDate(p.lastDate)})` : ''}
        {p.fxPerEur ? ` · ${num(p.fxPerEur, 4)} ${tradeCurrencyOf(p.currency)}/€` : ''}{p.weightBp !== null ? ` · ${formatBp(p.weightBp)} de la cartera` : ''}
      </div>
      {p.gainCents !== null && p.gainCents > 0 && p.estimatedTaxCents !== null && (
        <div className="muted small">Si vendieras todo hoy: unos {formatCents(p.estimatedTaxCents)} de IRPF (escala del ahorro, con lo que ya has realizado este año en Hormiga).</div>
      )}
      <div style={{ margin: '8px 0' }}><Sparkline values={p.sparkline} up={trendUp} /></div>
      <Metrics x={p} />
      <Signals list={p.signals} />
      {p.warnings.map((t) => <Callout key={t} tone="warning">{t}</Callout>)}
      <div className="row" style={{ marginTop: 10, gap: 8 }}>
        <button className="btn sm" onClick={() => onTrade('sell')}>Registrar venta</button>
        <button className="btn sm" onClick={() => onTrade('buy')}>Comprar más</button>
      </div>
    </article>
  );
}

function Realized({ o }: { o: StocksOverview }) {
  if (!o.realized.length) return null;
  return (
    <Card title="Ganancias y pérdidas realizadas" hint="Método FIFO (las primeras acciones compradas son las primeras vendidas), como exige Hacienda. Euros al tipo de cambio de cada operación.">
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Año</th><th className="num">Ganancias</th><th className="num">Pérdidas</th><th className="num">Neto</th><th className="num">IRPF estimado</th></tr></thead>
          <tbody>
            {o.realized.map((r) => (
              <tr key={r.year}>
                <td>{r.year}{r.deferredLossCents > 0 && <div className="muted small">{formatCents(r.deferredLossCents)} de pérdidas aplazadas por la regla de los dos meses</div>}</td>
                <td className="num"><Money cents={r.gainsCents} /></td>
                <td className="num"><Money cents={-r.lossesCents} /></td>
                <td className="num"><Money cents={r.netCents} signed /></td>
                <td className="num">{r.netCents > 0 ? formatCents(r.estimatedTaxCents) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Estimación con la escala del ahorro (19 % hasta 6.000 €, 21 % hasta 50.000 €, 23 % hasta 200.000 €, 27 % hasta 300.000 €, 30 % a partir de ahí) solo con estas ventas: no incluye intereses, dividendos ni otras ganancias. Las pérdidas netas se pueden compensar durante los 4 años siguientes. Confírmalo en tu declaración.</p>
    </Card>
  );
}

function Trades({ o }: { o: StocksOverview }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  if (!o.trades.length) return null;
  const del = async (id: number) => {
    try {
      await api('stocks.deleteTrade', { id });
      invalidate();
    } catch (err) {
      toast({ tone: 'error', message: toApiError(err).message });
    }
  };
  return (
    <Card title="Tus operaciones">
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Fecha</th><th>Valor</th><th>Tipo</th><th className="num">Acciones</th><th className="num">Precio</th><th className="num">Comisiones</th><th className="num">Total</th><th /></tr></thead>
          <tbody>
            {o.trades.map((t) => (
              <tr key={t.id}>
                <td>{formatDate(t.date)}</td>
                <td><div className="cell-main">{t.name}</div><div className="cell-sub">{t.symbol}{t.note ? ` · ${t.note}` : ''}</div></td>
                <td>{t.side === 'buy' ? 'Compra' : 'Venta'}</td>
                <td className="num">{fmtQty(t.quantity)}</td>
                <td className="num">{fmtPrice(t.price, t.currency)}{t.currency !== 'EUR' && <div className="cell-sub">{num(t.fxPerEur, 4)} {t.currency}/€</div>}</td>
                <td className="num">{formatCents(t.feesCents)}</td>
                <td className="num">{formatCents(t.totalCents)}</td>
                <td><button className="btn sm link" aria-label={`Borrar operación del ${formatDate(t.date)}`} onClick={() => void del(t.id)}>Borrar</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function RulesCard({ rules }: { rules: StockRulesSettings }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const [r, setR] = useState(rules);
  const fields: { key: keyof Omit<StockRulesSettings, 'notify'>; label: string; help: string }[] = [
    { key: 'stopLossPct', label: 'Stop-loss (%)', help: 'Aviso de venta si la posición pierde este porcentaje.' },
    { key: 'trailingStopPct', label: 'Stop dinámico (%)', help: 'Aviso si cae este porcentaje desde su máximo desde que compraste (estando en beneficio).' },
    { key: 'takeProfitPct', label: 'Objetivo de beneficio (%)', help: 'Aviso para recoger beneficios.' },
    { key: 'dipPct', label: 'Corrección para comprar (%)', help: 'Caída mínima desde el máximo de 52 semanas, en tendencia alcista.' },
    { key: 'maxPositionPct', label: 'Peso máximo por valor (%)', help: 'Aviso de concentración y tamaño orientativo de una compra.' },
  ];
  const save = async () => {
    try {
      await api('settings.update', { stocks: r });
      invalidate();
      toast({ tone: 'info', message: 'Reglas guardadas.' });
    } catch (err) {
      toast({ tone: 'error', message: toApiError(err).message });
    }
  };
  return (
    <Card title="Tus reglas" hint="Las señales usan estos límites. Ajústalos a tu tolerancia al riesgo.">
      <div className="grid grid-3">
        {fields.map((f) => (
          <Field key={f.key} label={f.label} help={f.help} htmlFor={`rule-${f.key}`}>
            <input id={`rule-${f.key}`} className="input" type="number" min={1} max={f.key === 'takeProfitPct' ? 1000 : 100} value={r[f.key]} onChange={(e) => setR({ ...r, [f.key]: Number(e.target.value) })} />
          </Field>
        ))}
      </div>
      <label className="row" style={{ gap: 8, margin: '8px 0' }}>
        <input type="checkbox" checked={r.notify} onChange={(e) => setR({ ...r, notify: e.target.checked })} />
        Avisarme cuando empiece una señal de compra o venta (también con notificación de Windows si las tienes activadas)
      </label>
      <button className="btn primary" onClick={save}>Guardar reglas</button>
    </Card>
  );
}

function AddWatchDialog({ onClose }: { onClose: () => void }) {
  const invalidate = useInvalidate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MarketQuoteDTO[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setBusy(false);
    }
  };
  const search = () => run(async () => setResults(await api('market.search', { query: query.trim() })));
  const follow = (symbol: string) => run(async () => {
    await api('stocks.addWatch', { symbol });
    invalidate();
    onClose();
  });
  return (
    <Dialog open wide title="Seguir un valor" onClose={onClose} footer={<button className="btn" onClick={onClose}>Cerrar</button>}>
      <p className="muted small">Busca por nombre, ticker o ISIN. Solo se envía el texto que busques.</p>
      <div className="row">
        <input className="input" style={{ flex: 1 }} aria-label="Buscar valor" placeholder="Apple, SAN.MC, IWDA, Inditex…" maxLength={60} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && query.trim().length >= 2) void search(); }} />
        <button className="btn primary" disabled={busy || query.trim().length < 2} onClick={() => void search()}>Buscar</button>
      </div>
      {error && <Callout tone="danger">{error}</Callout>}
      {busy && <Loading label="Consultando…" />}
      {results && (results.length === 0 ? <p className="muted">Sin resultados.</p> : (
        <table className="table">
          <thead><tr><th>Valor</th><th>Tipo</th><th>Mercado</th><th /></tr></thead>
          <tbody>
            {results.filter((r) => r.type !== 'INDEX' && r.type !== 'MUTUALFUND').map((r) => (
              <tr key={r.symbol}>
                <td><div className="cell-main">{r.name}</div><div className="cell-sub">{r.symbol}</div></td>
                <td>{r.type === 'ETF' ? 'ETF' : 'Acción'}</td>
                <td>{r.exchange}</td>
                <td><button className="btn sm primary" disabled={busy} onClick={() => void follow(r.symbol)}>Seguir</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </Dialog>
  );
}

function TradeDialog({ initial, overview, onClose }: { initial: Partial<StockTradeInput>; overview: StocksOverview | null; onClose: () => void }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const [side, setSide] = useState<'buy' | 'sell'>(initial.side ?? 'buy');
  const [symbol, setSymbol] = useState(initial.symbol ?? '');
  const [date, setDate] = useState(todayIso());
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState(initial.price ? String(Math.round(initial.price * 100) / 100).replace('.', ',') : '');
  const [currency, setCurrency] = useState(initial.currency ?? 'EUR');
  const [fx, setFx] = useState('');
  const [fees, setFees] = useState<number | null>(0);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const known = overview ? [...overview.positions, ...overview.watchlist].find((x) => x.symbol === symbol.trim().toUpperCase()) : undefined;
  useEffect(() => {
    if (known?.currency) setCurrency(tradeCurrencyOf(known.currency));
  }, [known?.currency]);
  const q = parseNum(qty), p = parseNum(price), f = parseNum(fx);
  const isEur = currency.toUpperCase() === 'EUR';
  const preview = q && p && (isEur || f) ? Math.round(((q * p) / (isEur ? 1 : f!)) * 100) + (side === 'buy' ? 1 : -1) * (fees ?? 0) : null;
  const held = overview?.positions.find((x) => x.symbol === symbol.trim().toUpperCase());

  const save = async () => {
    setError(null);
    if (!/^[A-Za-z0-9.\-=^]{1,24}$/.test(symbol.trim())) return setError('Indica el símbolo (ticker) del valor, por ejemplo SAN.MC o AAPL.');
    if (!q || q <= 0) return setError('Número de acciones no válido.');
    if (!p || p <= 0) return setError('Precio no válido.');
    if (!/^[A-Za-z]{3}$/.test(currency.trim())) return setError('Moneda de 3 letras (EUR, USD…).');
    if (!isEur && fx.trim() && (!f || f <= 0)) return setError('Tipo de cambio no válido.');
    try {
      await api('stocks.addTrade', {
        symbol: symbol.trim().toUpperCase(), side, date, quantity: q, price: p, currency: currency.trim().toUpperCase(),
        fxPerEur: isEur ? 1 : fx.trim() ? f : null, feesCents: fees ?? 0, note: note.trim() || null,
      });
      invalidate();
      toast({ tone: 'info', message: side === 'buy' ? 'Compra registrada.' : 'Venta registrada.' });
      onClose();
    } catch (err) {
      setError(toApiError(err).message);
    }
  };

  return (
    <Dialog open title="Registrar operación" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}>
      <p className="muted small">Copia los datos de la confirmación de tu bróker. Se guardan solo en este equipo.</p>
      <Segmented label="Tipo de operación" value={side} onChange={setSide} options={[{ value: 'buy', label: 'Compra' }, { value: 'sell', label: 'Venta' }]} />
      <div className="grid grid-2">
        <Field label="Símbolo (ticker)" htmlFor="tr-symbol" help={known ? known.name : 'Ej.: SAN.MC, ITX.MC, AAPL, IWDA.AS'}>
          <input id="tr-symbol" className="input" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
        </Field>
        <Field label="Fecha" htmlFor="tr-date">
          <input id="tr-date" className="input" type="date" max={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Número de acciones" htmlFor="tr-qty" help={side === 'sell' && held ? `Tienes ${fmtQty(held.shares)}` : undefined}>
          <input id="tr-qty" className="input" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label={`Precio por acción (${currency || 'moneda'})`} htmlFor="tr-price">
          <input id="tr-price" className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="Moneda" htmlFor="tr-cur">
          <input id="tr-cur" className="input" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </Field>
        {!isEur && (
          <Field label={`Tipo de cambio (${currency} por 1 €)`} htmlFor="tr-fx" help="El de tu bróker. Vacío: el del cierre de ese día.">
            <input id="tr-fx" className="input" inputMode="decimal" placeholder="Ej.: 1,0850" value={fx} onChange={(e) => setFx(e.target.value)} />
          </Field>
        )}
        <Field label="Comisiones y gastos (€)" htmlFor="tr-fees">
          <EuroInput id="tr-fees" valueCents={fees} onChange={setFees} />
        </Field>
        <Field label="Nota (opcional)" htmlFor="tr-note">
          <input id="tr-note" className="input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      {preview !== null && <p className="small">{side === 'buy' ? 'Total pagado' : 'Total recibido'}: <strong>{formatCents(preview)}</strong>{side === 'buy' ? ' (comisiones incluidas)' : ' (comisiones descontadas)'}</p>}
      {error && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
}
