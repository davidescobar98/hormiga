import { useEffect, useRef, useState } from 'react';
import { api, toApiError, useInvalidate, useQuery } from '../api';
import { useNavigate } from '../App';
import { formatDate, todayIso } from '../../../shared/dates';
import { formatBp, formatCents } from '../../../shared/money';
import { ACCOUNT_KINDS, ACCOUNT_KIND_LABELS, type AccountDTO, type AccountKind, type CounterpartyRole, type CounterpartySummary } from '../../../shared/types';
import { Badge, Callout, Card, Dialog, EmptyState, ErrorBox, EuroInput, Field, Loading, Money, useToast } from '../components/ui';

const parsePct = (t: string): number | null => {
  const s = t.trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

export function AccountsPage({ initialSection }: { initialSection?: string }) {
  const q = useQuery(() => api('accounts.list'), []);
  const [balanceOf, setBalanceOf] = useState<AccountDTO | null>(null);
  const [editing, setEditing] = useState<AccountDTO | null>(null);
  const [merging, setMerging] = useState<AccountDTO | null>(null);
  const [creating, setCreating] = useState<{ ownTransferTarget: boolean } | null>(null);
  const navigate = useNavigate();
  const transfersRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (initialSection === 'transfers') transfersRef.current?.scrollIntoView({ block: 'start' });
  }, [initialSection, q.data]);

  const accounts = q.data ?? [];
  const shown = accounts.filter((a) => a.movementsCount > 0 || a.sourceKind === 'manual' || a.balanceCents !== null);
  const liquid = shown.filter((a) => a.includeInNetWorth && a.balanceCents !== null && a.sourceKind !== 'card').reduce((t, a) => t + a.balanceCents!, 0);
  const unknown = shown.filter((a) => a.balanceCents === null && a.sourceKind !== 'card' && a.includeInNetWorth);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Cuentas</h1>
          <p className="subtitle">Cada cuenta o tarjeta de la que importas movimientos, con su saldo calculado. Añade también las cuentas que no importas (por ejemplo una remunerada en otro banco) para que tus traspasos no se pierdan.</p>
        </div>
        <button className="btn primary" onClick={() => setCreating({ ownTransferTarget: false })}>Añadir cuenta manual</button>
      </div>
      {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
      {!q.data ? <Loading /> : shown.length === 0 ? (
        <Card><EmptyState title="Aún no hay cuentas" icon="wallet" actions={<button className="btn primary" onClick={() => setCreating({ ownTransferTarget: false })}>Añadir cuenta manual</button>}>Se crean solas al importar extractos. También puedes añadir a mano las que no importas.</EmptyState></Card>
      ) : (
        <>
          <section className="card hero" aria-label="Saldo total">
            <div className="hero-main">
              <span className="stat-label">Dinero en tus cuentas</span>
              <span className="hero-figure num">{formatCents(liquid)}</span>
              <span className="muted small">Suma de los saldos conocidos de las cuentas que cuentan en tu patrimonio.</span>
            </div>
          </section>
          {unknown.length > 0 && (
            <Callout tone="info">
              {unknown.length === 1 ? `Falta el saldo de «${unknown[0]!.name}».` : `Faltan los saldos de ${unknown.length} cuentas.`} Indícalo una vez (el de hoy o el de una fecha cualquiera) y Hormiga lo mantendrá al día con tus movimientos.
            </Callout>
          )}
          <div className="grid grid-3">
            {shown.map((a) => (
              <article key={a.id} className="card account-card" aria-label={a.name}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div className="cell-main">{a.name}</div>
                    <div className="cell-sub">{a.bank} · {ACCOUNT_KIND_LABELS[a.kind]}{a.sourceKind === 'manual' ? ' · manual' : ''}</div>
                  </div>
                  <div className="row" style={{ gap: 4 }}>
                    {a.ownTransferTarget && <Badge tone="accent" title="Recibe las transferencias a tu nombre cuya cuenta de destino no importas">Destino de tus traspasos</Badge>}
                    {!a.includeInNetWorth && <Badge tone="outline">Fuera del patrimonio</Badge>}
                  </div>
                </div>
                <div style={{ margin: '12px 0' }}>
                  {a.sourceKind === 'card' ? (
                    <span className="muted small">Las tarjetas no tienen saldo propio: sus compras se cargan en tu cuenta.</span>
                  ) : a.balanceCents === null ? (
                    <button className="btn sm primary" onClick={() => setBalanceOf(a)}>Indicar saldo</button>
                  ) : (
                    <>
                      <span className="stat-value"><Money cents={a.balanceCents} /></span>
                      <div className="muted small">
                        {a.anchor?.source === 'statement' ? `Según el saldo impreso el ${formatDate(a.anchor.date)}` : a.anchor ? `Desde el saldo que indicaste el ${formatDate(a.anchor.date)}` : ''}
                        {a.annualRateBp ? ` · ${formatBp(a.annualRateBp, 2)} TAE estimada` : ''}
                      </div>
                    </>
                  )}
                </div>
                <div className="small muted">
                  {a.movementsCount} movimientos{a.lastDate ? ` · último ${formatDate(a.lastDate)}` : ''}
                  {(a.last30InCents > 0 || a.last30OutCents > 0) && <> · 30 días: +{formatCents(a.last30InCents)} / −{formatCents(a.last30OutCents)}</>}
                </div>
                <div className="row" style={{ marginTop: 10, gap: 4, flexWrap: 'wrap' }}>
                  {a.movementsCount > 0 && <button className="btn sm" onClick={() => navigate('transactions', { accountId: a.id })}>Ver movimientos</button>}
                  {a.sourceKind !== 'card' && a.balanceCents !== null && <button className="btn sm ghost" onClick={() => setBalanceOf(a)}>Corregir saldo</button>}
                  <button className="btn sm ghost" onClick={() => setEditing(a)}>Editar</button>
                  {shown.filter((x) => x.id !== a.id && x.sourceKind === a.sourceKind).length > 0 && a.sourceKind !== 'manual' && <button className="btn sm ghost" onClick={() => setMerging(a)}>Unir con…</button>}
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      <section ref={transfersRef}>
        <TransfersReview accounts={accounts} onCreateAccount={() => setCreating({ ownTransferTarget: true })} />
      </section>

      {balanceOf && <BalanceDialog account={balanceOf} onClose={() => setBalanceOf(null)} />}
      {editing && <EditAccountDialog account={editing} onClose={() => setEditing(null)} />}
      {merging && <MergeDialog account={merging} accounts={shown} onClose={() => setMerging(null)} />}
      {creating && <ManualAccountDialog ownTransferTarget={creating.ownTransferTarget} onClose={() => setCreating(null)} />}
    </div>
  );
}

function BalanceDialog({ account, onClose }: { account: AccountDTO; onClose: () => void }) {
  const [value, setValue] = useState<number | null>(account.balanceCents);
  const [date, setDate] = useState(todayIso());
  const [error, setError] = useState<string | null>(null);
  const invalidate = useInvalidate();
  const save = async () => {
    if (value === null) return setError('Indica el saldo.');
    try {
      await api('accounts.setBalance', { id: account.id, balanceCents: value, date });
      invalidate();
      onClose();
    } catch (err) {
      setError(toApiError(err).message);
    }
  };
  return (
    <Dialog open title={`Saldo de «${account.name}»`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Guardar saldo</button></>}>
      <p className="muted small">El saldo al final del día indicado (con los movimientos de ese día incluidos). Con él, Hormiga calcula el saldo de cualquier otro día sumando o restando tus movimientos.</p>
      <div className="form-row">
        <Field label="Saldo" htmlFor="ac-bal"><EuroInput id="ac-bal" valueCents={value} onChange={setValue} /></Field>
        <Field label="A fecha de" htmlFor="ac-date"><input id="ac-date" type="date" className="input" max={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      {error && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
}

function EditAccountDialog({ account, onClose }: { account: AccountDTO; onClose: () => void }) {
  const [name, setName] = useState(account.name);
  const [kind, setKind] = useState<AccountKind>(account.kind);
  const [include, setInclude] = useState(account.includeInNetWorth);
  const [rate, setRate] = useState(account.annualRateBp ? String(account.annualRateBp / 100).replace('.', ',') : '');
  const [target, setTarget] = useState(account.ownTransferTarget);
  const [error, setError] = useState<string | null>(null);
  const invalidate = useInvalidate();
  const toast = useToast();
  const save = async () => {
    try {
      await api('accounts.update', { id: account.id, name: name.trim(), kind, includeInNetWorth: include, annualRateBp: account.sourceKind === 'manual' ? parsePct(rate) : undefined, ownTransferTarget: target });
      invalidate();
      onClose();
    } catch (err) {
      setError(toApiError(err).message);
    }
  };
  const remove = async () => {
    if (!confirm(`¿Eliminar la cuenta manual «${account.name}»? Tus transferencias hacia ella volverán a quedar sin destino.`)) return;
    await api('accounts.deleteManual', { id: account.id });
    toast({ tone: 'info', message: 'Cuenta eliminada.' });
    invalidate();
    onClose();
  };
  return (
    <Dialog open title="Editar cuenta" onClose={onClose} footer={<>{account.sourceKind === 'manual' && <button className="btn danger" onClick={remove}>Eliminar</button>}<button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}>
      <div className="form-row">
        <Field label="Nombre" htmlFor="ea-name"><input id="ea-name" className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Tipo" htmlFor="ea-kind">
          <select id="ea-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as AccountKind)}>
            {ACCOUNT_KINDS.map((k) => <option key={k} value={k}>{ACCOUNT_KIND_LABELS[k]}</option>)}
          </select>
        </Field>
        {account.sourceKind === 'manual' && (
          <Field label="Rentabilidad (TAE, opcional)" htmlFor="ea-rate" help="Para estimar los intereses de una cuenta remunerada.">
            <div className="euro-input pct"><input id="ea-rate" className="input num" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
          </Field>
        )}
      </div>
      <label className="check"><input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} />Contar su saldo en mi patrimonio</label>
      {account.sourceKind !== 'card' && (
        <label className="check"><input type="checkbox" checked={target} onChange={(e) => setTarget(e.target.checked)} />Es la cuenta donde van mis transferencias a mi nombre cuando no importo su destino</label>
      )}
      {error && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
}

function MergeDialog({ account, accounts, onClose }: { account: AccountDTO; accounts: AccountDTO[]; onClose: () => void }) {
  const options = accounts.filter((a) => a.id !== account.id && a.sourceKind === account.sourceKind);
  const [into, setInto] = useState(options[0]?.id ?? 0);
  const invalidate = useInvalidate();
  const merge = async () => {
    await api('accounts.merge', { fromId: account.id, intoId: into });
    invalidate();
    onClose();
  };
  return (
    <Dialog open title="Unir cuentas" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!into} onClick={merge}>Unir</button></>}>
      <p>Úsalo cuando la misma cuenta aparece dos veces (por ejemplo, importada con y sin los últimos dígitos). Los movimientos de «{account.name}» pasarán a:</p>
      <select className="select" aria-label="Cuenta de destino" value={into} onChange={(e) => setInto(Number(e.target.value))}>
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </Dialog>
  );
}

function ManualAccountDialog({ ownTransferTarget, onClose }: { ownTransferTarget: boolean; onClose: () => void }) {
  const [name, setName] = useState(ownTransferTarget ? 'Cuenta remunerada' : '');
  const [bank, setBank] = useState('');
  const [kind, setKind] = useState<AccountKind>(ownTransferTarget ? 'savings' : 'current');
  const [balance, setBalance] = useState<number | null>(null);
  const [date, setDate] = useState(todayIso());
  const [rate, setRate] = useState('');
  const [target, setTarget] = useState(ownTransferTarget);
  const [error, setError] = useState<string | null>(null);
  const invalidate = useInvalidate();
  const save = async () => {
    if (!name.trim()) return setError('Ponle un nombre.');
    if (balance === null) return setError('Indica su saldo en una fecha.');
    try {
      await api('accounts.createManual', { name: name.trim(), bank: bank.trim(), kind, balanceCents: balance, date, annualRateBp: parsePct(rate), ownTransferTarget: target });
      invalidate();
      onClose();
    } catch (err) {
      setError(toApiError(err).message);
    }
  };
  return (
    <Dialog open wide title="Añadir cuenta manual" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}>
      <p className="muted small">Para cuentas de las que no importas movimientos. Su saldo se calcula desde el que indiques, sumando las transferencias que le envías desde tus cuentas importadas (y restando las que traes), más los intereses si pones su rentabilidad.</p>
      <div className="form-row">
        <Field label="Nombre" htmlFor="ma-name"><input id="ma-name" className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Banco (opcional)" htmlFor="ma-bank"><input id="ma-bank" className="input" maxLength={80} value={bank} onChange={(e) => setBank(e.target.value)} /></Field>
        <Field label="Tipo" htmlFor="ma-kind">
          <select id="ma-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as AccountKind)}>
            {ACCOUNT_KINDS.filter((k) => k !== 'card').map((k) => <option key={k} value={k}>{ACCOUNT_KIND_LABELS[k]}</option>)}
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field label="Saldo" htmlFor="ma-bal"><EuroInput id="ma-bal" valueCents={balance} onChange={setBalance} /></Field>
        <Field label="A fecha de" htmlFor="ma-date" help="Las transferencias posteriores a esta fecha se sumarán solas."><input id="ma-date" type="date" className="input" max={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Rentabilidad (TAE, opcional)" htmlFor="ma-rate"><div className="euro-input pct"><input id="ma-rate" className="input num" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></div></Field>
      </div>
      <label className="check"><input type="checkbox" checked={target} onChange={(e) => setTarget(e.target.checked)} />Aquí van mis transferencias a mi nombre (cuando no indique otra cuenta)</label>
      {error && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
}

function TransfersReview({ accounts, onCreateAccount }: { accounts: AccountDTO[]; onCreateAccount: () => void }) {
  const q = useQuery(() => api('accounts.counterparties'), []);
  const cats = useQuery(() => api('categories.list'), []);
  const settings = useQuery(() => api('settings.get'), []);
  const [showAll, setShowAll] = useState(false);
  const invalidate = useInvalidate();
  const toast = useToast();
  const navigate = useNavigate();
  const targets = accounts.filter((a) => a.sourceKind !== 'card');
  const spendCats = (cats.data ?? []).filter((c) => !c.excludedFromSpending);

  const decide = async (c: CounterpartySummary, role: CounterpartyRole | null, accountId: number | null, categoryId: number | null) => {
    try {
      const r = await api('accounts.decideCounterparty', { key: c.key, displayName: c.displayName, role, accountId, categoryId });
      toast({ tone: 'info', message: r.changed > 0 ? `${r.changed} movimientos actualizados.` : 'Guardado.' });
      q.reload();
      invalidate();
    } catch (err) {
      toast({ tone: 'error', message: toApiError(err).message });
    }
  };

  const list = q.data ?? [];
  const pending = list.filter((c) => c.needsReview);
  const visible = showAll ? list : list.slice(0, 12);
  return (
    <Card
      title="Revisa tus transferencias"
      hint="Dile a Hormiga quién es cada beneficiario una sola vez: se aplica a todos sus movimientos, pasados y futuros"
    >
      <div className="stack">
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          <li><strong>Es mía</strong>: dinero movido entre tus cuentas. No es gasto ni ingreso y mantienes la liquidez (sale de un saldo y entra en otro).</li>
          <li><strong>Mi pareja</strong>: gastos compartidos del hogar.</li>
          <li><strong>Otra persona</strong>: cuenta como gasto (o ingreso si te pagan); elige su categoría real, por ejemplo Vivienda para el alquiler.</li>
        </ul>
        {settings.data && settings.data.profile.ownerNames.length === 0 && (
          <Callout tone="info">
            Indica tu nombre tal como aparece en el banco y Hormiga reconocerá solas las transferencias a tus otras cuentas.{' '}
            <button className="btn link" onClick={() => navigate('settings', { section: 'profile' })}>Completar mi perfil</button>
          </Callout>
        )}
        {pending.length > 0 && (
          <Callout tone="warning">
            {pending.length === 1 ? 'Hay 1 beneficiario' : `Hay ${pending.length} beneficiarios`} con transferencias grandes (≥ 1.000 €) sin revisar. Mientras tanto se tratan como dinero movido a otra cuenta tuya; confírmalo o corrígelo para que tu ahorro sea exacto.
          </Callout>
        )}
        {!q.data ? <Loading /> : list.length === 0 ? <p className="muted">No hay transferencias con beneficiario identificable en tus movimientos.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Beneficiario / ordenante</th><th className="right">Enviado</th><th className="right">Recibido</th><th className="right">Mayor</th><th>Quién es</th><th /></tr></thead>
              <tbody>
                {visible.map((c) => (
                  <tr key={c.key}>
                    <td>
                      <div className="cell-main">{c.displayName}{c.needsReview && <> <Badge tone="warning">Sin revisar</Badge></>}</div>
                      <div className="cell-sub">{c.count} movimiento{c.count === 1 ? '' : 's'}{c.lastDate ? ` · último ${formatDate(c.lastDate)}` : ''}</div>
                    </td>
                    <td className="right"><Money cents={c.sentCents} /></td>
                    <td className="right"><Money cents={c.receivedCents} /></td>
                    <td className="right"><Money cents={c.largestCents} /></td>
                    <td>
                      <select className="select compact" aria-label={`Quién es ${c.displayName}`} value={c.role ?? ''} onChange={(e) => {
                        const role = (e.target.value || null) as CounterpartyRole | null;
                        const acc = role === 'own' ? (targets.find((a) => a.ownTransferTarget)?.id ?? null) : null;
                        void decide(c, role, acc, null);
                      }}>
                        <option value="">Sin revisar</option>
                        <option value="own">Es mía</option>
                        <option value="partner">Mi pareja</option>
                        <option value="other">Otra persona</option>
                      </select>
                    </td>
                    <td>
                      {c.role === 'own' && (
                        <select className="select compact" aria-label={`Cuenta de ${c.displayName}`} value={c.accountId ?? ''} onChange={(e) => {
                          if (e.target.value === 'new') return onCreateAccount();
                          void decide(c, 'own', e.target.value ? Number(e.target.value) : null, null);
                        }}>
                          <option value="">Cuenta no registrada</option>
                          {targets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                          <option value="new">+ Crear cuenta…</option>
                        </select>
                      )}
                      {c.role === 'other' && (
                        <select className="select compact" aria-label={`Categoría de ${c.displayName}`} value={c.categoryId ?? ''} onChange={(e) => void decide(c, 'other', null, e.target.value ? Number(e.target.value) : null)}>
                          <option value="">Bizum y transferencias</option>
                          {spendCats.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
                        </select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.length > 12 && <button className="btn ghost sm" onClick={() => setShowAll(!showAll)}>{showAll ? 'Ver menos' : `Ver los ${list.length}`}</button>}
        {accounts.some((a) => a.sourceKind !== 'card') && !accounts.some((a) => a.ownTransferTarget) && list.some((c) => c.role === 'own' && !c.accountId) && (
          <Callout tone="info">
            Tienes transferencias a cuentas tuyas que Hormiga no sigue. <button className="btn link" onClick={onCreateAccount}>Añade esa cuenta</button> (por ejemplo tu cuenta remunerada) para que su saldo crezca con cada traspaso y siga contando en tu patrimonio.
          </Callout>
        )}
      </div>
    </Card>
  );
}
