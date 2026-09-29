import { centsToDecimalString } from '../../shared/money';
import { addMonths, monthOf, todayIso } from '../../shared/dates';
import { CLASSIFICATION_SOURCE_LABELS, TRANSACTION_TYPE_LABELS } from '../../shared/types';
import type { Repos } from './context';
import type { ImportService } from './importService';
import { generateDemoRows } from './demoData';

const DEMO_INCOME_LABEL = 'Nómina (demo)';
const DEMO_SUFFIX = ' (demo)';

/** Escapes a CSV cell and neutralises spreadsheet formula injection (=, +, -, @ at the start of text). */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export class DataService {
  constructor(private readonly repos: Repos, private readonly importer: ImportService, private readonly now: () => Date) {}

  /** Semicolon-separated, decimal comma, UTF-8 with BOM: opens correctly in Spanish Excel/LibreOffice. */
  exportCsv(): string {
    const header = ['fecha', 'fecha_valor', 'descripcion_original', 'comercio', 'categoria', 'tipo', 'importe', 'moneda', 'origen_clasificacion', 'excluido', 'notas', 'documento_id'];
    const lines = [header.join(';')];
    for (const t of this.repos.transactions.exportAll()) {
      lines.push(
        [
          csvCell(t.date), csvCell(t.bookingDate), csvCell(t.descriptionRaw), csvCell(t.merchantName), csvCell(t.categoryName),
          csvCell(TRANSACTION_TYPE_LABELS[t.type]), centsToDecimalString(t.amountCents), t.currency,
          csvCell(CLASSIFICATION_SOURCE_LABELS[t.classificationSource]), t.isExcluded ? 'si' : 'no', csvCell(t.notes), csvCell(t.documentId),
        ].join(';'),
      );
    }
    return `\uFEFF${lines.join('\r\n')}\r\n`;
  }

  exportJson(): string {
    return JSON.stringify(
      {
        format: 'hormiga-export',
        version: 1,
        exportedAt: this.now().toISOString(),
        note: 'Importes en céntimos de euro (enteros). amountCents > 0 = entrada de dinero, < 0 = salida.',
        categories: this.repos.categories.list(),
        rules: this.repos.rules.list(),
        income: this.repos.income.list(),
        savingsGoal: this.repos.goals.latest(),
        recurring: this.repos.recurring.list(),
        savingsPots: this.repos.pots.exportAll(),
        assets: this.repos.assets.list(),
        assetValuations: this.repos.assets.valuations(),
        transactions: this.repos.transactions.exportAll(),
      },
      null,
      2,
    );
  }

  loadDemo(): { transactions: number } {
    if (this.repos.documents.demoDocumentIds().length > 0) return { transactions: 0 };
    const rows = generateDemoRows(this.now());
    const { inserted } = this.importer.insertSyntheticDocument('Datos de demostración (ficticios)', rows);
    if (this.repos.income.list().length === 0) {
      this.repos.income.save({ kind: 'salary', label: DEMO_INCOME_LABEL, amountCents: 245000, startMonth: rows[0]!.date.slice(0, 7), endMonth: null });
    }
    if (!this.repos.goals.latest()) {
      this.repos.goals.set({ mode: 'amount', amountCents: 60000, percentBp: null, effectiveFrom: rows[0]!.date.slice(0, 7) }, monthOf(todayIso(this.now())));
      this.repos.settings.setRaw('demo.goalSet', true);
    }
    this.loadDemoWealth();
    return { transactions: inserted };
  }

  /** Fictitious savings pots and wealth items (names end in "(demo)" so they can be removed later). */
  private loadDemoWealth(): void {
    const today = todayIso(this.now());
    const month = monthOf(today);
    const day = (m: string, d = 1) => `${m}-${String(d).padStart(2, '0')}`;
    const past = (n: number) => addMonths(month, -n);
    this.repos.db.transaction(() => {
      if (!this.repos.pots.list().some((p) => p.kind === 'emergency')) {
        const e = this.repos.pots.save({ name: `Fondo de emergencia${DEMO_SUFFIX}`, kind: 'emergency', targetCents: 900000, targetDate: null, color: '#2f8f6b' });
        this.repos.db.run('UPDATE savings_pots SET created_at = ? WHERE id = ?', `${day(past(11))}T09:00:00.000Z`, e);
        for (let i = 11; i >= 0; i--) this.repos.pots.addMovement(e, day(past(i), 2), 30000, 'Aportación mensual');
      }
      const trip = this.repos.pots.save({ name: `Viaje a Japón${DEMO_SUFFIX}`, kind: 'goal', targetCents: 350000, targetDate: day(addMonths(month, 8), 15), color: '#1f9aa8' });
      this.repos.db.run('UPDATE savings_pots SET created_at = ? WHERE id = ?', `${day(past(5))}T09:00:00.000Z`, trip);
      for (let i = 5; i >= 0; i--) this.repos.pots.addMovement(trip, day(past(i), 2), 15000, 'Aportación');

      const cash = this.repos.assets.save({ name: `Cuenta de ahorro${DEMO_SUFFIX}`, type: 'cash', institution: 'Banco ficticio', notes: null });
      const fund = this.repos.assets.save({ name: `Fondo indexado global${DEMO_SUFFIX}`, type: 'fund', institution: 'Gestora ficticia', notes: 'Aportación periódica de 200 €/mes' });
      const remunerated = this.repos.assets.save({ name: `Cuenta remunerada${DEMO_SUFFIX}`, type: 'deposit', institution: 'Banco ficticio', notes: null, mode: 'rate', annualRateBp: 250, monthlyContributionCents: 10000 });
      this.repos.assets.upsertValuation({ assetId: remunerated, date: day(past(6), 1), valueCents: 500000, contributedCents: 500000, note: null });
      this.repos.assets.save({ name: `Préstamo coche${DEMO_SUFFIX}`, type: 'loan', institution: 'Banco ficticio', notes: null, mode: 'loan', principalCents: 1200000, annualRateBp: 695, termMonths: 60, startDate: day(past(14), 10) });
      this.repos.assets.save({ name: `Hipoteca${DEMO_SUFFIX}`, type: 'mortgage', institution: 'Banco ficticio', notes: 'Tipo fijo', mode: 'loan', principalCents: 18000000, annualRateBp: 275, termMonths: 300, startDate: day(past(30), 5) });
      let fundValue = 150000;
      let contributed = 150000;
      for (let i = 11; i >= 0; i--) {
        const date = day(past(i), 28);
        const k = 11 - i;
        this.repos.assets.upsertValuation({ assetId: cash, date, valueCents: 420000 + k * 25000, contributedCents: null, note: null });
        // Deterministic ups and downs, clearly fictitious.
        contributed += 20000;
        fundValue = Math.round(fundValue * (1 + [0.012, -0.018, 0.021, 0.004, -0.009, 0.015, 0.007, -0.022, 0.019, 0.011, -0.004, 0.013][k]!)) + 20000;
        this.repos.assets.upsertValuation({ assetId: fund, date, valueCents: fundValue, contributedCents: contributed, note: null });
      }
    });
  }

  /**
   * Removes everything that came from imported files or Gmail (movements, documents, review items and
   * derived statistics) so it can be loaded again. Keeps settings, categories, rules, known merchants,
   * income, goals, savings pots, wealth and the Gmail connection.
   */
  clearImported(): { transactions: number; documents: number } {
    const db = this.repos.db;
    return db.transaction(() => {
      const transactions = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions')!.n);
      const documents = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM documents')!.n);
      for (const table of ['import_review_items', 'transactions', 'recurring_expenses', 'recommendations', 'email_imports', 'statements', 'documents']) {
        db.run(`DELETE FROM ${table}`);
      }
      this.repos.settings.delete('demo.goalSet');
      return { transactions, documents };
    });
  }

  removeDemo(): { removed: number } {
    let removed = 0;
    this.repos.db.transaction(() => {
      for (const id of this.repos.documents.demoDocumentIds()) {
        removed += this.repos.documents.get(id).txCount;
        this.repos.documents.delete(id);
      }
      for (const i of this.repos.income.list()) if (i.label === DEMO_INCOME_LABEL) this.repos.income.delete(i.id);
      if (this.repos.settings.getRaw<boolean>('demo.goalSet')) {
        this.repos.goals.set(null, monthOf(todayIso(this.now())));
        this.repos.settings.delete('demo.goalSet');
      }
      for (const p of this.repos.pots.list()) if (p.name.endsWith(DEMO_SUFFIX)) this.repos.pots.delete(p.id);
      for (const a of this.repos.assets.list()) if (a.name.endsWith(DEMO_SUFFIX)) this.repos.assets.delete(a.id);
      // Merchants no longer referenced are dropped to keep the catalogue clean.
      this.repos.db.run('DELETE FROM merchants WHERE id NOT IN (SELECT DISTINCT merchant_id FROM transactions WHERE merchant_id IS NOT NULL)');
    });
    return { removed };
  }
}
