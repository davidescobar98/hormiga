import type { AssetInput, AssetType, PotInput, PotKind, PotMovementDTO, ValuationDTO, ValuationInput, ValuationMode } from '../../shared/types';
import { AppError, notFound } from '../errors';
import type { Database } from './database';

export interface PotRow {
  id: number;
  name: string;
  kind: PotKind;
  targetCents: number;
  targetDate: string | null;
  color: string;
  createdAt: string;
  savedCents: number;
  movementsCount: number;
  lastMovementDate: string | null;
}

export class PotsRepo {
  constructor(private readonly db: Database, private readonly now: () => Date) {}

  list(): PotRow[] {
    return this.db
      .all<{ id: number; name: string; kind: PotKind; target_cents: number; target_date: string | null; color: string; created_at: string; saved: number | null; n: number; last: string | null }>(
        `SELECT p.id, p.name, p.kind, p.target_cents, p.target_date, p.color, p.created_at,
                (SELECT SUM(amount_cents) FROM pot_movements m WHERE m.pot_id = p.id) AS saved,
                (SELECT COUNT(*) FROM pot_movements m WHERE m.pot_id = p.id) AS n,
                (SELECT MAX(date) FROM pot_movements m WHERE m.pot_id = p.id) AS last
         FROM savings_pots p WHERE p.archived = 0
         ORDER BY CASE p.kind WHEN 'emergency' THEN 0 ELSE 1 END, COALESCE(p.target_date, '9999'), p.id`,
      )
      .map((r) => ({
        id: r.id, name: r.name, kind: r.kind, targetCents: Number(r.target_cents), targetDate: r.target_date, color: r.color,
        createdAt: r.created_at, savedCents: Number(r.saved ?? 0), movementsCount: Number(r.n), lastMovementDate: r.last,
      }));
  }

  get(id: number): PotRow {
    const p = this.list().find((x) => x.id === id);
    if (!p) throw notFound('La meta');
    return p;
  }

  save(input: PotInput): number {
    const ts = this.now().toISOString();
    if (input.kind === 'emergency') {
      const other = this.db.get<{ id: number }>("SELECT id FROM savings_pots WHERE kind = 'emergency' AND archived = 0 AND id <> ?", input.id ?? -1);
      if (other) throw new AppError('CONFLICT', 'Ya tienes un fondo de emergencia. Edítalo en lugar de crear otro.');
    }
    if (input.id) {
      const r = this.db.run(
        'UPDATE savings_pots SET name = ?, kind = ?, target_cents = ?, target_date = ?, color = ?, updated_at = ? WHERE id = ? AND archived = 0',
        input.name.trim(), input.kind, input.targetCents, input.targetDate, input.color, ts, input.id,
      );
      if (r.changes === 0) throw notFound('La meta');
      return input.id;
    }
    return this.db.run(
      'INSERT INTO savings_pots(name, kind, target_cents, target_date, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      input.name.trim(), input.kind, input.targetCents, input.targetDate, input.color, ts, ts,
    ).lastInsertRowid;
  }

  delete(id: number): boolean {
    return this.db.run('DELETE FROM savings_pots WHERE id = ?', id).changes > 0;
  }

  addMovement(potId: number, date: string, amountCents: number, note: string | null): number {
    this.get(potId);
    return this.db.run(
      'INSERT INTO pot_movements(pot_id, date, amount_cents, note, created_at) VALUES (?, ?, ?, ?, ?)',
      potId, date, amountCents, note, this.now().toISOString(),
    ).lastInsertRowid;
  }

  deleteMovement(id: number): boolean {
    return this.db.run('DELETE FROM pot_movements WHERE id = ?', id).changes > 0;
  }

  movements(potId: number): PotMovementDTO[] {
    return this.db
      .all<{ id: number; pot_id: number; date: string; amount_cents: number; note: string | null }>(
        'SELECT id, pot_id, date, amount_cents, note FROM pot_movements WHERE pot_id = ? ORDER BY date DESC, id DESC', potId,
      )
      .map((r) => ({ id: r.id, potId: r.pot_id, date: r.date, amountCents: Number(r.amount_cents), note: r.note }));
  }

  exportAll() {
    return { pots: this.list(), movements: this.db.all('SELECT * FROM pot_movements ORDER BY pot_id, date') };
  }
}

export interface AssetRow {
  id: number;
  name: string;
  type: AssetType;
  institution: string | null;
  notes: string | null;
  mode: ValuationMode;
  annualRateBp: number | null;
  monthlyContributionCents: number | null;
  principalCents: number | null;
  termMonths: number | null;
  startDate: string | null;
  symbol: string | null;
  rateSource: string | null;
}

const ASSET_COLS = `id, name, type, institution, notes, valuation_mode AS mode, annual_rate_bp AS annualRateBp,
  monthly_contribution_cents AS monthlyContributionCents, principal_cents AS principalCents, term_months AS termMonths,
  start_date AS startDate, symbol, rate_source AS rateSource`;

export class AssetsRepo {
  constructor(private readonly db: Database, private readonly now: () => Date) {}

  list(): AssetRow[] {
    return this.db.all<AssetRow>(`SELECT ${ASSET_COLS} FROM assets WHERE archived = 0 ORDER BY id`);
  }

  get(id: number): AssetRow {
    const a = this.db.get<AssetRow>(`SELECT ${ASSET_COLS} FROM assets WHERE id = ? AND archived = 0`, id);
    if (!a) throw notFound('El activo');
    return a;
  }

  save(input: AssetInput): number {
    const ts = this.now().toISOString();
    const mode = input.mode ?? 'manual';
    if (mode === 'loan' && !(input.principalCents && input.termMonths && input.startDate && input.annualRateBp !== null && input.annualRateBp !== undefined)) {
      throw new AppError('VALIDATION', 'Un préstamo necesita capital, tipo de interés (TIN), plazo en meses y fecha de inicio.');
    }
    if (mode === 'rate' && (input.annualRateBp === null || input.annualRateBp === undefined)) {
      throw new AppError('VALIDATION', 'Indica la rentabilidad anual para estimar el valor.');
    }
    const values = [
      input.name.trim(), input.type, input.institution, input.notes, mode,
      mode === 'manual' ? null : (input.annualRateBp ?? null),
      mode === 'rate' ? (input.monthlyContributionCents ?? null) : null,
      mode === 'loan' ? input.principalCents! : null,
      mode === 'loan' ? input.termMonths! : null,
      mode === 'loan' ? input.startDate! : null,
      input.symbol ?? null, input.rateSource ?? null,
    ];
    if (input.id) {
      const r = this.db.run(
        `UPDATE assets SET name = ?, type = ?, institution = ?, notes = ?, valuation_mode = ?, annual_rate_bp = ?,
           monthly_contribution_cents = ?, principal_cents = ?, term_months = ?, start_date = ?, symbol = ?, rate_source = ?, updated_at = ?
         WHERE id = ? AND archived = 0`,
        ...values, ts, input.id,
      );
      if (r.changes === 0) throw notFound('El activo');
      return input.id;
    }
    return this.db.run(
      `INSERT INTO assets(name, type, institution, notes, valuation_mode, annual_rate_bp, monthly_contribution_cents, principal_cents,
         term_months, start_date, symbol, rate_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...values, ts, ts,
    ).lastInsertRowid;
  }

  delete(id: number): boolean {
    return this.db.run('DELETE FROM assets WHERE id = ?', id).changes > 0;
  }

  /** One valuation per asset and day: saving the same date again replaces it. */
  upsertValuation(v: ValuationInput): number {
    this.get(v.assetId);
    this.db.run(
      `INSERT INTO asset_valuations(asset_id, date, value_cents, contributed_cents, note, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(asset_id, date) DO UPDATE SET value_cents = excluded.value_cents, contributed_cents = excluded.contributed_cents, note = excluded.note`,
      v.assetId, v.date, v.valueCents, v.contributedCents, v.note, this.now().toISOString(),
    );
    return this.db.get<{ id: number }>('SELECT id FROM asset_valuations WHERE asset_id = ? AND date = ?', v.assetId, v.date)!.id;
  }

  deleteValuation(id: number): boolean {
    return this.db.run('DELETE FROM asset_valuations WHERE id = ?', id).changes > 0;
  }

  valuations(assetId?: number): ValuationDTO[] {
    const rows = assetId === undefined
      ? this.db.all<{ id: number; asset_id: number; date: string; value_cents: number; contributed_cents: number | null; note: string | null }>(
          'SELECT v.* FROM asset_valuations v JOIN assets a ON a.id = v.asset_id WHERE a.archived = 0 ORDER BY v.date')
      : this.db.all<{ id: number; asset_id: number; date: string; value_cents: number; contributed_cents: number | null; note: string | null }>(
          'SELECT * FROM asset_valuations WHERE asset_id = ? ORDER BY date DESC', assetId);
    return rows.map((r) => ({
      id: r.id, assetId: r.asset_id, date: r.date, valueCents: Number(r.value_cents),
      contributedCents: r.contributed_cents === null ? null : Number(r.contributed_cents), note: r.note,
    }));
  }
}
