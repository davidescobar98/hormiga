import { formatCents } from '../../shared/money';
import { addMonths, daysBetween, monthOf, monthRange, todayIso } from '../../shared/dates';
import type { AssetDTO, EarlyRepaymentDTO, EmergencyInfo, LoanInfo, LoanScheduleRow, MarketQuoteDTO, MarketReturnsDTO, PotDTO, PotsOverview, WealthOverview } from '../../shared/types';
import { INVESTMENT_TYPES } from '../../shared/types';
import { potProgress } from '../domain/pots';
import { allocation, assetValueAt, gain, isLiability, netWorthAt, netWorthHistory, valuesAt, type AssetRef } from '../domain/wealth';
import { earlyRepayment, loanStatus, schedule, type EarlyRepaymentStrategy, type LoanTerms } from '../domain/loans';
import { historicalReturns } from '../domain/returns';
import type { AssetRow, AssetsRepo, PotsRepo } from '../db/wealthRepo';
import type { MarketProvider } from '../market/yahoo';
import { AppError } from '../errors';
import type { AnalyticsService } from './analyticsService';

/** Days without a new valuation after which an asset is flagged as out of date. */
const STALE_DAYS = 90;

/** Savings goals ("metas"), emergency fund and wealth tracking. Informative only: no product recommendations. */
export class WealthService {
  constructor(
    private readonly pots: PotsRepo,
    private readonly assets: AssetsRepo,
    private readonly analytics: AnalyticsService,
    private readonly now: () => Date,
    private readonly market: MarketProvider | null = null,
    private readonly marketEnabled: () => boolean = () => false,
  ) {}

  private today() {
    return todayIso(this.now());
  }

  potDTOs(): PotDTO[] {
    const today = this.today();
    return this.pots.list().map((p) => {
      const pr = potProgress({ targetCents: p.targetCents, targetDate: p.targetDate, createdOn: p.createdAt.slice(0, 10), savedCents: p.savedCents, today });
      return { ...p, ...pr, createdAt: p.createdAt };
    });
  }

  emergency(pots: PotDTO[]): EmergencyInfo {
    const e = this.analytics.essentialMonthly();
    const pot = pots.find((p) => p.kind === 'emergency') ?? null;
    const saved = pot?.savedCents ?? 0;
    const coverageTenths = e.cents > 0 ? Math.floor((saved * 10) / e.cents) : null;
    const period = e.months === 1 ? 'del último mes' : `de los últimos ${e.months} meses`;
    return {
      essentialMonthlyCents: e.cents,
      monthsUsed: e.months,
      savedCents: saved,
      coverageTenths,
      potId: pot?.id ?? null,
      suggestedTargetCents: { months3: e.cents * 3, months6: e.cents * 6 },
      explanation: e.months === 0
        ? 'Aún no hay meses completos con datos para estimar tu gasto esencial.'
        : `Gasto esencial mensual = media ${period} en categorías esenciales (vivienda, supermercado, suministros, seguros, salud, transporte…), incluidos recibos recurrentes: ${formatCents(e.cents)}. Cobertura = fondo de emergencia ÷ gasto esencial mensual.`,
    };
  }

  potsOverview(): PotsOverview {
    const pots = this.potDTOs();
    const emergency = this.emergency(pots);
    const savings = this.analytics.savings();
    const capacity = savings.hasData ? savings.capacity.capacityCents : null;
    const active = pots.filter((p) => p.status !== 'done');
    const required = active.reduce((a, p) => a + (p.requiredMonthlyCents ?? 0), 0);
    const insights: PotsOverview['insights'] = [];

    if (emergency.coverageTenths !== null) {
      const months = emergency.coverageTenths / 10;
      if (!emergency.potId) {
        insights.push({ tone: 'info', text: `Todavía no tienes fondo de emergencia. Una referencia habitual es reservar entre 3 y 6 meses de gasto esencial (${formatCents(emergency.suggestedTargetCents.months3)} – ${formatCents(emergency.suggestedTargetCents.months6)}).` });
      } else if (months < 3) {
        insights.push({ tone: 'warning', text: `Tu fondo de emergencia cubre ${months.toLocaleString('es-ES', { maximumFractionDigits: 1 })} meses de gasto esencial. La referencia habitual es de 3 a 6 meses.` });
      } else {
        insights.push({ tone: 'positive', text: `Tu fondo de emergencia cubre ${months.toLocaleString('es-ES', { maximumFractionDigits: 1 })} meses de gasto esencial.` });
      }
    }
    if (capacity !== null && required > 0) {
      insights.push(
        required <= capacity
          ? { tone: 'positive', text: `Tus metas necesitan ${formatCents(required)}/mes y tu capacidad de ahorro estimada es de ${formatCents(capacity)}/mes: encajan.` }
          : { tone: 'warning', text: `Tus metas necesitan ${formatCents(required)}/mes, más que tu capacidad de ahorro estimada (${formatCents(capacity)}/mes). Puedes ampliar plazos, ajustar importes o revisar gastos en «Ahorro».` },
      );
    }
    for (const p of pots.filter((x) => x.status === 'behind' || x.status === 'overdue')) {
      insights.push({
        tone: 'warning',
        text: p.status === 'overdue'
          ? `«${p.name}» ha pasado su fecha objetivo con ${formatCents(p.remainingCents)} pendientes.`
          : `«${p.name}» va por detrás del plan: faltan ${formatCents(p.remainingCents)}; necesitas ${formatCents(p.requiredMonthlyCents ?? 0)}/mes para llegar a tiempo.`,
      });
    }
    for (const p of pots.filter((x) => x.status === 'done')) insights.push({ tone: 'positive', text: `Has completado «${p.name}».` });

    return {
      pots,
      emergency,
      totalSavedCents: pots.reduce((a, p) => a + p.savedCents, 0),
      requiredMonthlyTotalCents: required,
      capacityCents: capacity,
      capacityProvisional: savings.capacity.provisional,
      insights,
    };
  }

  private refs(rows = this.assets.list()): (AssetRef & { row: AssetRow })[] {
    return rows.map((a) => ({
      id: a.id,
      type: a.type,
      mode: a.mode,
      annualRateBp: a.annualRateBp,
      monthlyContributionCents: a.monthlyContributionCents,
      loan: a.mode === 'loan' && a.principalCents && a.termMonths && a.startDate && a.annualRateBp !== null
        ? { principalCents: a.principalCents, annualRateBp: a.annualRateBp, termMonths: a.termMonths, startDate: a.startDate }
        : null,
      row: a,
    }));
  }

  assetDTOs(): AssetDTO[] {
    const today = this.today();
    const all = this.assets.valuations();
    const latest = valuesAt(all, today);
    const counts = new Map<number, number>();
    for (const v of all) counts.set(v.assetId, (counts.get(v.assetId) ?? 0) + 1);
    return this.refs().map((ref) => {
      const a = ref.row;
      const real = latest.get(a.id);
      const v = assetValueAt(ref, real, today);
      const g = gain(a.type, v?.valueCents ?? null, v?.contributedCents ?? null);
      let loan: LoanInfo | null = null;
      if (ref.loan) loan = { ...ref.loan, ...loanStatus(ref.loan, today) };
      return {
        id: a.id,
        name: a.name,
        type: a.type,
        institution: a.institution,
        notes: a.notes,
        mode: a.mode,
        annualRateBp: a.annualRateBp,
        monthlyContributionCents: a.monthlyContributionCents,
        symbol: a.symbol,
        rateSource: a.rateSource,
        isLiability: isLiability(a.type),
        valueCents: v?.valueCents ?? null,
        contributedCents: v?.contributedCents ?? null,
        ...g,
        estimated: v?.estimated ?? false,
        baseDate: v?.baseDate ?? null,
        loan,
        lastDate: real?.date ?? null,
        valuationsCount: counts.get(a.id) ?? 0,
        // Estimated and loan values update themselves; only manual values go stale.
        stale: a.mode === 'manual' && !!real && daysBetween(real.date, today) > STALE_DAYS,
      };
    });
  }

  wealthOverview(): WealthOverview {
    const today = this.today();
    const assets = this.assetDTOs();
    const refs = this.refs();
    const vals = this.assets.valuations();
    const nw = netWorthAt(refs, vals, today);
    const invested = assets.filter((a) => INVESTMENT_TYPES.includes(a.type) && a.valueCents !== null && a.contributedCents !== null);
    const investedValue = invested.reduce((s, a) => s + a.valueCents!, 0);
    const investedContributed = invested.reduce((s, a) => s + a.contributedCents!, 0);
    const starts = [...vals.map((v) => v.date), ...refs.map((r) => r.loan?.startDate).filter((d): d is string => !!d)].sort();
    const current = monthOf(today);
    const first = starts.length ? monthOf(starts[0]!) : current;
    const from = first < addMonths(current, -35) ? addMonths(current, -35) : first;
    return {
      assets,
      totalAssetsCents: nw.assetsCents,
      totalLiabilitiesCents: nw.liabilitiesCents,
      netWorthCents: nw.netWorthCents,
      investedValueCents: investedValue,
      investedContributedCents: investedContributed,
      investedGainCents: investedValue - investedContributed,
      investedReturnBp: investedContributed > 0 ? Math.round(((investedValue - investedContributed) * 10000) / investedContributed) : null,
      allocation: allocation(assets.filter((a) => a.valueCents !== null).map((a) => ({ type: a.type, valueCents: a.valueCents! }))),
      history: starts.length ? netWorthHistory(refs, vals, monthRange(from, current), today) : [],
      potsSavedCents: this.pots.list().reduce((a, p) => a + p.savedCents, 0),
    };
  }

  private loanTerms(assetId: number): LoanTerms {
    const ref = this.refs([this.assets.get(assetId)])[0]!;
    if (!ref.loan) throw new AppError('VALIDATION', 'Este elemento no es un préstamo con cuadro de amortización.');
    return ref.loan;
  }

  loanSchedule(assetId: number): LoanScheduleRow[] {
    return schedule(this.loanTerms(assetId));
  }

  earlyRepayment(assetId: number, date: string, amountCents: number, strategy: EarlyRepaymentStrategy): EarlyRepaymentDTO {
    return earlyRepayment(this.loanTerms(assetId), date, amountCents, strategy);
  }

  // ───────── Public market data (opt-in) ─────────

  private requireMarket(): MarketProvider {
    if (!this.market) throw new AppError('MARKET_DISABLED', 'Consulta de mercado no disponible.');
    if (!this.marketEnabled()) {
      throw new AppError('MARKET_DISABLED', 'Activa «Consultar rentabilidades pasadas en internet» para buscar datos de mercado. Solo se envía el nombre, ticker o ISIN que busques.');
    }
    return this.market;
  }

  async marketSearch(query: string): Promise<MarketQuoteDTO[]> {
    return this.requireMarket().search(query);
  }

  async marketReturns(symbol: string): Promise<MarketReturnsDTO> {
    const provider = this.requireMarket();
    const h = await provider.monthlyHistory(symbol);
    const r = historicalReturns(h.points);
    if (!r) throw new AppError('NOT_FOUND', `No hay suficiente histórico de «${symbol}» para calcular rentabilidades.`);
    const base = h.points[0]!.price;
    const yearly = new Map<string, { date: string; value: number }>();
    for (const p of h.points) yearly.set(p.date.slice(0, 4), { date: p.date, value: Math.round((p.price / base) * 10000) / 100 });
    return {
      symbol: h.symbol,
      name: h.name,
      currency: h.currency,
      source: provider.source,
      fetchedOn: this.today(),
      ...r,
      indexSeries: [{ date: h.points[0]!.date, value: 100 }, ...yearly.values()],
    };
  }
}
