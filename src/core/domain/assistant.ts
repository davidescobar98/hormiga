import { addDays, addMonths, lastDayOfMonth, monthOf, type IsoDate } from '../../shared/dates';
import { HELP_ARTICLES, type HelpArticle } from '../../shared/help';

/*
 * The assistant understands a small set of questions about your money in Spanish and answers them with your own
 * data, computed locally. It is deterministic (no language model, nothing leaves the computer): when it does not
 * understand, it says so and suggests help articles.
 */

export type Intent = 'spending' | 'income' | 'savings' | 'balance' | 'recurring' | 'forecast' | 'upcoming' | 'tips' | 'budget' | 'networth' | 'help';

export interface Period {
  from: IsoDate;
  to: IsoDate;
  label: string;
  /** True when the user did not say a period (a default was used). */
  implicit: boolean;
}

export const norm = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[¿?¡!.,;:()"«»]/g, ' ').replace(/\s+/g, ' ').trim();

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function detectIntent(q: string): Intent {
  const t = norm(q);
  if (/\b(como|que) (puedo|podria|deberia|hago para)\b.*\b(ahorr|gastar menos|reduc|recort)|consejo|optimiz|recortar|gastar menos|ahorrar mas/.test(t)) return 'tips';
  if (/prevision|fin de mes|acabare|acabar el mes|terminare|voy a gastar|me (va a )?quedar|llegare|numeros rojos|en negativo/.test(t)) return 'forecast';
  if (/proxim[oa]s? (pagos|cobros|recibos|cargos|movimientos)|que (pagos|recibos|cargos) (tengo|me vienen|vienen)|pagos? (de )?(esta|la proxima) semana/.test(t)) return 'upcoming';
  if (/suscripcion|recurrente|recibos|cuotas? (mensual|fija)/.test(t)) return 'recurring';
  if (/presupuesto/.test(t)) return 'budget';
  if (/patrimonio|cuanto valgo|deuda total/.test(t)) return 'networth';
  if (/saldo|cuanto dinero tengo|dinero (tengo|hay) en|liquidez|cuanto tengo en (la|mi|mis) cuenta/.test(t)) return 'balance';
  if (/ahorr/.test(t)) return 'savings';
  if (/ingres|cobr[eoa]|gane|nomina|sueldo|salario/.test(t)) return 'income';
  if (/gast|pagu|pague|me cuesta|cuesta|cuanto (llevo|me he dejado)|desembols/.test(t)) return 'spending';
  return 'help';
}

/** Period mentioned in the question; `fallback` when none (e.g. this month). */
export function detectPeriod(q: string, today: IsoDate, fallback: 'this_month' | 'last_month' | 'this_year' = 'this_month'): Period {
  const t = norm(q);
  const ym = monthOf(today);
  const year = Number(today.slice(0, 4));
  const month = (m: string, label: string): Period => ({ from: `${m}-01`, to: lastDayOfMonth(m) > today ? today : lastDayOfMonth(m), label, implicit: false });
  if (/\bhoy\b/.test(t)) return { from: today, to: today, label: 'hoy', implicit: false };
  if (/\bayer\b/.test(t)) return { from: addDays(today, -1), to: addDays(today, -1), label: 'ayer', implicit: false };
  if (/semana pasada/.test(t)) {
    const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
    const mon = addDays(today, -dow - 7);
    return { from: mon, to: addDays(mon, 6), label: 'la semana pasada', implicit: false };
  }
  if (/esta semana/.test(t)) {
    const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
    return { from: addDays(today, -dow), to: today, label: 'esta semana', implicit: false };
  }
  const lastN = t.match(/ultim[oa]s (\d{1,2}|dos|tres|seis|doce) (mes|meses|dias)/);
  if (lastN) {
    const words: Record<string, number> = { dos: 2, tres: 3, seis: 6, doce: 12 };
    const n = words[lastN[1]!] ?? Number(lastN[1]);
    if (lastN[2]!.startsWith('dia')) return { from: addDays(today, -n + 1), to: today, label: `los últimos ${n} días`, implicit: false };
    const first = addMonths(ym, -n);
    return { from: `${first}-01`, to: lastDayOfMonth(addMonths(ym, -1)), label: `los últimos ${n} meses completos`, implicit: false };
  }
  if (/mes pasado|ultimo mes/.test(t)) return month(addMonths(ym, -1), 'el mes pasado');
  if (/este mes|mes actual|en lo que va de mes/.test(t)) return month(ym, 'este mes');
  if (/ano pasado/.test(t)) return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31`, label: `${year - 1}`, implicit: false };
  if (/este ano|en lo que va de ano|ano actual/.test(t)) return { from: `${year}-01-01`, to: today, label: 'este año', implicit: false };
  for (let i = 0; i < 12; i++) {
    const m = t.match(new RegExp(`\\b${MONTHS[i]}\\b(?: (?:de |del )?(\\d{4}))?`));
    if (m) {
      let y = m[1] ? Number(m[1]) : year;
      // "en noviembre" said in March means last November.
      if (!m[1] && `${y}-${String(i + 1).padStart(2, '0')}` > ym) y -= 1;
      const key = `${y}-${String(i + 1).padStart(2, '0')}`;
      return month(key, `${MONTHS[i]} de ${y}`);
    }
  }
  const yr = t.match(/\b(20\d{2})\b/);
  if (yr) {
    const y = Number(yr[1]);
    return { from: `${y}-01-01`, to: y === year ? today : `${y}-12-31`, label: `${y}`, implicit: false };
  }
  if (fallback === 'last_month') return { ...month(addMonths(ym, -1), 'el mes pasado'), implicit: true };
  if (fallback === 'this_year') return { from: `${year}-01-01`, to: today, label: 'este año', implicit: true };
  return { ...month(ym, 'este mes'), implicit: true };
}

/** Words that mean a category, beyond its own name. */
const SYNONYMS: Record<string, string[]> = {
  restaurants: ['restaurante', 'restaurantes', 'comer fuera', 'cenas', 'bares', 'bar', 'comida fuera'],
  groceries: ['super', 'supermercado', 'supermercados', 'compra', 'comida'],
  fuel: ['gasolina', 'gasoil', 'diesel', 'combustible'],
  utilities: ['luz', 'agua', 'gas', 'internet', 'telefono', 'movil', 'suministros'],
  leisure: ['ocio', 'cine', 'conciertos'],
  travel: ['viaje', 'viajes', 'vacaciones', 'hotel', 'vuelos'],
  shopping: ['compras', 'ropa', 'amazon'],
  housing: ['alquiler', 'vivienda', 'casa'],
  transport: ['transporte', 'metro', 'taxi', 'uber', 'cabify'],
  people: ['bizum', 'bizums', 'transferencias'],
  loans: ['hipoteca', 'prestamo', 'prestamos'],
  subscriptions: ['suscripciones', 'suscripcion'],
};

export interface Named {
  id: number;
  name: string;
  key?: string | null;
}

/** Longest category or merchant name found in the question. Merchants win over categories at equal length. */
export function findTarget(q: string, categories: Named[], merchants: Named[]): { type: 'category' | 'merchant'; id: number; name: string } | null {
  const t = ` ${norm(q)} `;
  type Found = { type: 'category' | 'merchant'; id: number; name: string; len: number };
  const found: { best: Found | null } = { best: null };
  const consider = (type: 'category' | 'merchant', id: number, name: string, word: string) => {
    const w = norm(word);
    if (w.length < 3) return;
    if (t.includes(` ${w} `) || (w.length >= 5 && t.includes(` ${w}`))) {
      const b = found.best;
      if (!b || w.length > b.len || (w.length === b.len && type === 'merchant')) found.best = { type, id, name, len: w.length };
    }
  };
  for (const c of categories) {
    consider('category', c.id, c.name, c.name);
    for (const s of SYNONYMS[c.key ?? ''] ?? []) consider('category', c.id, c.name, s);
  }
  for (const m of merchants) consider('merchant', m.id, m.name, m.name);
  if (!found.best) return null;
  return { type: found.best.type, id: found.best.id, name: found.best.name };
}

/** Help articles ranked by shared words with the question. */
export function searchHelp(q: string, limit = 3): HelpArticle[] {
  const words = norm(q).split(' ').filter((w) => w.length >= 3 && !STOP.has(w));
  if (!words.length) return [];
  return HELP_ARTICLES.map((a) => {
    const title = norm(a.title);
    const keys = a.keywords.map(norm);
    const body = norm(a.body.join(' '));
    let score = 0;
    for (const w of words) {
      if (keys.some((k) => k === w || k.includes(w))) score += 3;
      if (title.includes(w)) score += 2;
      if (body.includes(w)) score += 1;
    }
    for (const k of keys) if (k.includes(' ') && norm(q).includes(k)) score += 4;
    return { a, score };
  })
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.a);
}

/** The paragraph of an article that answers the question (the first one when no specific answer matches). */
export function bestParagraph(q: string, a: HelpArticle): string {
  const t = norm(q);
  const hit = a.answers?.find((x) => x.when.some((w) => t.includes(norm(w))));
  return a.body[hit?.paragraph ?? 0] ?? a.body[0]!;
}

const STOP = new Set(['que', 'como', 'cuanto', 'cuanta', 'cuantos', 'donde', 'para', 'por', 'los', 'las', 'del', 'una', 'uno', 'unos', 'con', 'sin', 'mis', 'tus', 'esta', 'este', 'esto', 'puedo', 'hago', 'hay', 'tengo', 'quiero', 'hormiga', 'mas', 'muy']);
