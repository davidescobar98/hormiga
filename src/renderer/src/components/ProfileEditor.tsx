import { useState } from 'react';
import { api, toApiError, useInvalidate, useQuery } from '../api';
import {
  HOUSEHOLDS, HOUSEHOLD_LABELS, HOUSINGS, HOUSING_LABELS, INCOME_STABILITIES, INCOME_STABILITY_LABELS, LIFE_GOALS, LIFE_GOAL_LABELS,
  type FinancialProfile, type Household, type Housing, type IncomeStability, type LifeGoal,
} from '../../../shared/types';
import { Callout, Field, useToast } from './ui';

/** Optional personal context that tailors suggestions. Everything stays on this computer. */
export function ProfileEditor({ profile }: { profile: FinancialProfile }) {
  const [p, setP] = useState<FinancialProfile>(profile);
  const [names, setNames] = useState(profile.ownerNames.join(', '));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cats = useQuery(() => api('categories.list'), []);
  const invalidate = useInvalidate();
  const toast = useToast();
  const discretionary = (cats.data ?? []).filter((c) => c.kind === 'discretionary');

  const save = async () => {
    setError(null);
    const ownerNames = names.split(/[,\n]/).map((n) => n.trim()).filter(Boolean);
    if (ownerNames.some((n) => n.split(/\s+/).length < 2)) return setError('Escribe al menos nombre y un apellido, tal como aparece en tus transferencias.');
    setBusy(true);
    try {
      await api('settings.update', { profile: { ...p, ownerNames, partnerName: p.partnerName?.trim() || null } });
      toast({ tone: 'info', message: 'Perfil guardado. Las sugerencias y tus transferencias se han actualizado.' });
      invalidate();
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <div className="stack">
      <p className="muted small">Todo es opcional y se guarda solo en este ordenador. Sirve para reconocer tus traspasos entre cuentas, calcular el colchón que te conviene y no sugerirte recortar lo que más valoras.</p>
      <div className="form-row">
        <Field label="Tu nombre como aparece en el banco" htmlFor="pf-names" help="Nombre y apellidos; si aparece de varias formas, sepáralas con comas. Las transferencias a ese nombre se tratan como movimientos entre tus cuentas.">
          <input id="pf-names" className="input" maxLength={200} value={names} onChange={(e) => setNames(e.target.value)} placeholder="Nombre Apellido Apellido" />
        </Field>
        <Field label="¿Con quién vives?" htmlFor="pf-house">
          <select id="pf-house" className="select" value={p.household ?? ''} onChange={(e) => setP({ ...p, household: (e.target.value || null) as Household | null })}>
            <option value="">Prefiero no decirlo</option>
            {HOUSEHOLDS.map((h) => <option key={h} value={h}>{HOUSEHOLD_LABELS[h]}</option>)}
          </select>
        </Field>
        {p.household === 'couple' && (
          <Field label="Nombre de tu pareja en el banco (opcional)" htmlFor="pf-partner" help="Sus Bizum y transferencias contarán como gastos compartidos del hogar.">
            <input id="pf-partner" className="input" maxLength={80} value={p.partnerName ?? ''} onChange={(e) => setP({ ...p, partnerName: e.target.value })} />
          </Field>
        )}
      </div>
      <div className="form-row">
        <Field label="Personas a tu cargo" htmlFor="pf-dep" help="Hijos u otros familiares que dependen de tus ingresos.">
          <input id="pf-dep" type="number" min={0} max={20} className="input num" value={p.dependents} onChange={(e) => setP({ ...p, dependents: Math.max(0, Math.min(20, Number(e.target.value) || 0)) })} />
        </Field>
        <Field label="Vivienda" htmlFor="pf-housing">
          <select id="pf-housing" className="select" value={p.housing ?? ''} onChange={(e) => setP({ ...p, housing: (e.target.value || null) as Housing | null })}>
            <option value="">Prefiero no decirlo</option>
            {HOUSINGS.map((h) => <option key={h} value={h}>{HOUSING_LABELS[h]}</option>)}
          </select>
        </Field>
        <Field label="Tus ingresos" htmlFor="pf-income">
          <select id="pf-income" className="select" value={p.incomeStability ?? ''} onChange={(e) => setP({ ...p, incomeStability: (e.target.value || null) as IncomeStability | null })}>
            <option value="">Prefiero no decirlo</option>
            {INCOME_STABILITIES.map((h) => <option key={h} value={h}>{INCOME_STABILITY_LABELS[h]}</option>)}
          </select>
        </Field>
      </div>
      <fieldset className="fieldset">
        <legend>¿Qué quieres conseguir?</legend>
        <div className="chips">
          {LIFE_GOALS.map((g) => (
            <label key={g} className={`chip ${p.goals.includes(g) ? 'on' : ''}`}>
              <input type="checkbox" className="sr-only" checked={p.goals.includes(g)} onChange={() => setP({ ...p, goals: toggle<LifeGoal>(p.goals, g) })} />
              {LIFE_GOAL_LABELS[g]}
            </label>
          ))}
        </div>
      </fieldset>
      {discretionary.length > 0 && (
        <fieldset className="fieldset">
          <legend>Lo que más valoras (no te sugeriremos recortarlo)</legend>
          <div className="chips">
            {discretionary.map((c) => (
              <label key={c.id} className={`chip ${p.priorityCategoryIds.includes(c.id) ? 'on' : ''}`}>
                <input type="checkbox" className="sr-only" checked={p.priorityCategoryIds.includes(c.id)} onChange={() => setP({ ...p, priorityCategoryIds: toggle(p.priorityCategoryIds, c.id) })} />
                {c.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {error && <Callout tone="danger">{error}</Callout>}
      <div><button className="btn primary" disabled={busy} onClick={save}>Guardar perfil</button></div>
    </div>
  );
}
