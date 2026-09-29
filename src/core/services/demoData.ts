import { addMonths, daysInMonth, monthOf, parseYearMonth, toIso, todayIso, type YearMonth } from '../../shared/dates';
import type { TransactionType } from '../../shared/types';
import { normalizeMerchant, normalizeText } from '../domain/merchant';
import { inferTransactionType } from '../domain/transactionType';

/** Deterministic PRNG so demo data is reproducible (tests rely on it). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DemoRow {
  date: string;
  bookingDate: null;
  descriptionRaw: string;
  descriptionNormalized: string;
  merchant: ReturnType<typeof normalizeMerchant>;
  amountCents: number;
  type: TransactionType;
}

/**
 * Generates `months` months of clearly fictitious movements ending in the previous calendar month.
 * Includes rent, groceries, restaurants, subscriptions, insurance, utilities, fuel, shopping with a refund,
 * a summer trip, fees, cash, an internal transfer and payroll — enough to exercise every screen.
 */
export function generateDemoRows(now: Date, months = 12, seed = 20260101): DemoRow[] {
  const rnd = mulberry32(seed);
  const between = (min: number, max: number) => Math.round(min + rnd() * (max - min));
  const pick = <T>(list: T[]) => list[Math.floor(rnd() * list.length)]!;
  const lastMonth = addMonths(monthOf(todayIso(now)), -1);
  const first = addMonths(lastMonth, -(months - 1));
  const rows: { date: string; desc: string; cents: number }[] = [];

  for (let i = 0; i < months; i++) {
    const ym: YearMonth = addMonths(first, i);
    const { y, m } = parseYearMonth(ym);
    const D = daysInMonth(y, m);
    const day = (d: number) => toIso(y, m, Math.min(d, D));
    const late = i >= months - 2; // the last two months spend more on restaurants
    const add = (d: number, desc: string, cents: number) => rows.push({ date: day(d), desc, cents });

    add(28, 'ABONO NOMINA EMPRESA FICTICIA DEMO SL', 245000);
    add(1, 'RECIBO ALQUILER VIVIENDA INMOBILIARIA DEMO', -85000);
    add(2, 'TRANSFERENCIA A CUENTA AHORRO PROPIA', -20000);
    add(3, 'ADEUDO BASIC FIT SPAIN SA', -2999);
    add(5, 'PAGO NETFLIX.COM AMSTERDAM', -1299);
    add(12, 'PAGO SPOTIFY P1234ABC STOCKHOLM', -1099);
    add(20, 'APPLE.COM/BILL ITUNES.COM', -299);
    add(8, 'RECIBO MOVISTAR FIBRA Y MOVIL', -4500);
    add(10, 'RECIBO MAPFRE SEGUROS AUTO', -3850);
    add(15, 'RECIBO IBERDROLA CLIENTES SAU', -between(4200, 7600));

    const groceries = between(5, 7);
    for (let g = 0; g < groceries; g++) add(between(1, D), `COMPRA TARJ. 4B MERCADONA ${between(1000, 9999)} MADRID`, -between(2400, 9200));
    for (let g = 0; g < 2; g++) add(between(1, D), 'COMPRA TARJETA LIDL SUPERMERCADOS', -between(1500, 4800));

    const dining = late ? between(9, 12) : between(4, 6);
    for (let r = 0; r < dining; r++) {
      add(between(1, D), pick(['PAGO EN BAR LA ESQUINA MADRID', 'RESTAURANTE CASA PACO', 'GLOVO PEDIDO 8841', 'PAGO EN TABERNA EL PATIO']), -between(1200, late ? 5200 : 3800));
    }
    const coffees = between(9, 13);
    for (let c = 0; c < coffees; c++) add(between(1, D), 'PAGO EN CAFETERIA EL RINCON', -between(180, 380));
    for (let f = 0; f < 2; f++) add(between(1, D), `REPSOL E.S. ${between(1000, 9999)} ALCOBENDAS`, -between(4800, 6600));

    const shopping = between(1, 3);
    for (let s = 0; s < shopping; s++) add(between(1, D), 'AMZN MKTP ES*2K4 AMAZON.ES', -between(1500, 12000));
    if (i === months - 4) add(18, 'DEVOLUCION COMPRA AMAZON EU', 3499);
    if (m === 8) {
      add(4, 'VUELING AIRLINES BARCELONA', -18400);
      add(4, 'BOOKING.COM HOTEL RESERVA', -32000);
    }
    if (i % 3 === 0) add(22, 'REINTEGRO CAJERO BBVA', -5000);
    if (i >= months - 2) add(30, 'COMISION MANTENIMIENTO CUENTA', -300);
    if (i % 4 === 1) add(between(1, D), 'PAGO EN TIENDA NOVEDADES LUNA', -between(1800, 6000));
  }

  return rows
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => {
      const descriptionNormalized = normalizeText(r.desc);
      return {
        date: r.date,
        bookingDate: null,
        descriptionRaw: r.desc,
        descriptionNormalized,
        merchant: normalizeMerchant(r.desc),
        amountCents: r.cents,
        type: inferTransactionType(descriptionNormalized, r.cents, 'account').type,
      };
    });
}
