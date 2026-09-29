// End-to-end validation of the BUILT Electron app (run `npm run build` first).
// Uses an isolated, temporary profile and synthetic documents only. Screenshots go to ./.e2e-userdata/shots.
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { buildStatementPdf, sampleCardSpec } from '../tests/helpers/synthetic-statement.mjs';
import * as XLSX from 'xlsx';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'hormiga-e2e-'));
const userData = join(work, 'profile');
const shots = join(root, '.e2e-userdata', 'shots');
mkdirSync(shots, { recursive: true });

const aug = join(work, 'extracto-agosto.pdf');
const sep = join(work, 'extracto-septiembre.pdf');
writeFileSync(aug, await buildStatementPdf(sampleCardSpec()));
writeFileSync(sep, await buildStatementPdf(sampleCardSpec({
  period: ['01/09/2026', '30/09/2026'],
  pages: [[
    { date: '03/09/2026', desc: 'NOVEDADES BARRIO LUNA 5555', amount: '14,00' },
    { date: '04/09/2026', desc: 'COMPRA TARJ. MERCADONA 1234 MADRID', amount: '61,30' },
  ]],
  total: '75,30',
})));

// Fictitious CaixaBank-style .xls (binary BIFF) export.
const caixa = join(work, 'movimientos-caixabank.xls');
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Movimientos de cuenta (ficticio)'], [],
    ['Fecha', 'Fecha valor', 'Movimiento', 'Más datos', 'Importe', 'Saldo'],
    ['10/09/2026', '10/09/2026', 'BONPREU MOLLET', 'Fecha de operación: 09-09-2026', -32.15, 967.85],
    ['08/09/2026', '08/09/2026', 'TRANSF A FAVOR', 'EMPRESA FICTICIA SL', 1000, 1000],
  ]), 'Movimientos');
  writeFileSync(caixa, Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'biff8' })));
}

const results = [];
const step = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✔ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: String(err?.message ?? err).split('\n')[0] });
    await page?.screenshot({ path: join(shots, 'fail.png'), fullPage: true }).catch(() => {});
    console.log(`✘ ${name}: ${err?.message ?? err}`);
    if (typeof errors !== 'undefined' && errors.length) console.log('Errores del renderer:', errors.slice(-5).join(' | '));
    throw err;
  }
};

const env = { ...process.env, HORMIGA_USER_DATA: userData, HORMIGA_LOG_LEVEL: 'info' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;

const app = await electron.launch({ executablePath: require('electron'), args: [root], env, cwd: root });
const errors = [];
let page;
try {
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  await page.setViewportSize({ width: 1360, height: 900 });

  const stubOpen = (paths) => app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: p }); }, paths);
  const stubSave = (path) => app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, path);
  const btn = (name) => page.getByRole('button', { name, exact: true });

  await step('security: renderer has no Node access and a minimal bridge', async () => {
    const r = await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process, keys: Object.keys(window.hormiga ?? {}) }));
    if (r.require !== 'undefined' || r.process !== 'undefined') throw new Error(`Node expuesto: ${JSON.stringify(r)}`);
    if (r.keys.sort().join(',') !== 'invoke,on') throw new Error(`Puente inesperado: ${r.keys}`);
    const denied = await page.evaluate(() => window.hormiga.invoke('fs.readFile', {}).then(() => 'ok', (e) => e.message));
    if (!/no permitido/.test(denied)) throw new Error('Canal no permitido aceptado');
    const invalid = await page.evaluate(() => window.hormiga.invoke('transactions.update', { id: 1, sql: 'x' }).then(() => 'ok', (e) => e.code));
    if (invalid !== 'VALIDATION') throw new Error(`Validación IPC: ${invalid}`);
    const popup = await page.evaluate(() => window.open('https://example.com') === null);
    if (!popup) throw new Error('window.open permitido');
    const traversal = await page.evaluate(() => Promise.all(
      ['app://hormiga/%2e%2e%2fmain%2findex.js', 'app://hormiga/..%5c..%5cpackage.json', 'app://otro/index.html'].map((u) => fetch(u).then((r) => r.status, () => 'blocked')),
    ));
    if (traversal.some((s) => s === 200)) throw new Error(`Path traversal en app://: ${traversal}`);
    const external = await page.evaluate(() => fetch('https://www.google.com').then(() => 'ok', () => 'blocked'));
    if (external !== 'blocked') throw new Error('El renderer puede acceder a internet');
    errors.length = 0; // the probes above intentionally trigger CSP/403 console errors
  });

  await step('onboarding: welcome → privacy → skip Gmail', async () => {
    await page.getByRole('heading', { name: 'Bienvenido a Hormiga' }).waitFor();
    await page.screenshot({ path: join(shots, '01-onboarding.png') });
    await btn('Continuar').click();
    await page.getByRole('heading', { name: 'Tus datos se quedan en tu equipo' }).waitFor();
    await btn('Continuar').click();
    await page.getByRole('heading', { name: 'Conectar Gmail' }).waitFor();
    await btn('Continuar con importación manual').click();
  });

  await step('onboarding: configure income 2.500 €', async () => {
    await page.getByLabel('Importe mensual neto').fill('2.500,00');
    await btn('Añadir ingreso').click();
    await page.getByRole('cell', { name: /2\.500,00/ }).waitFor();
    await btn('Continuar').click();
  });

  await step('onboarding: savings goal 700 €/month', async () => {
    await page.getByLabel('Objetivo mensual').fill('700');
    await btn('Guardar objetivo').click();
    await page.getByText(/Objetivo actual: 700,00/).waitFor();
    await btn('Continuar').click();
  });

  await step('onboarding: manual import of a synthetic statement', async () => {
    await stubOpen([aug]);
    await btn('Importar documentos').click();
    await page.getByText(/6 movimientos importados/).waitFor({ timeout: 20000 });
    await page.screenshot({ path: join(shots, '02-import.png') });
    await btn('Continuar').click();
    await page.getByText(/sin clasificar/).first().waitFor();
    await btn('Ir al resumen').click();
  });

  await step('dashboard shows spending, income, savings and goal', async () => {
    await page.getByRole('heading', { name: 'Resumen', exact: true }).waitFor();
    await page.getByText('1.333,26 €').first().waitFor();
    const text = await page.locator('.hero').innerText();
    for (const expected of ['2.500,00', '1.166,74', '47 %', 'por encima']) if (!text.toLowerCase().includes(expected)) throw new Error(`Falta «${expected}» en el resumen: ${text}`);
    await page.screenshot({ path: join(shots, '03-dashboard.png'), fullPage: true });
  });

  await step('duplicate document is detected', async () => {
    await page.getByRole('button', { name: 'Documentos' }).first().click();
    await stubOpen([aug]);
    await page.locator('.page-header').getByRole('button', { name: 'Importar documento' }).click();
    await page.getByText(/ya se importó/).waitFor();
  });

  await step('manual category change → rule → next import is auto-categorized', async () => {
    await page.getByRole('button', { name: 'Movimientos' }).click();
    const select = page.getByLabel('Categoría de Novedades Barrio Luna');
    await select.selectOption({ label: 'Compras' });
    await page.getByRole('dialog').getByText(/Aplicar siempre la categoría/).waitFor();
    await page.screenshot({ path: join(shots, '04-rule.png') });
    await page.getByRole('dialog').getByRole('button', { name: 'Aplicar siempre' }).click();
    await page.getByText(/Regla creada/).waitFor();
    await stubOpen([sep]);
    await page.locator('.page-header').getByRole('button', { name: 'Importar documento' }).click();
    await page.getByText(/2 movimientos importados/).waitFor({ timeout: 20000 });
    const row = page.getByRole('row', { name: /Novedades Barrio Luna/ }).filter({ hasText: '14,00' });
    await row.waitFor();
    const origin = await row.innerText();
    if (!origin.includes('Tú')) throw new Error(`El nuevo movimiento no usó la regla: ${origin}`);
    const value = await row.getByRole('combobox').inputValue();
    const label = await row.getByRole('combobox').locator(`option[value="${value}"]`).innerText();
    if (label !== 'Compras') throw new Error(`Categoría inesperada: ${label}`);
  });

  await step('transaction detail shows traceability', async () => {
    await page.getByRole('row', { name: /Mercadona/ }).first().getByRole('cell').first().click();
    const dlg = page.getByRole('dialog');
    await dlg.getByText('Descripción original del banco').waitFor();
    const t = await dlg.innerText();
    for (const e of ['COMPRA TARJ. MERCADONA 1234 MADRID', 'Comercio conocido', 'extracto-', 'bbva-pdf-v1']) if (!t.includes(e)) throw new Error(`Falta «${e}» en el detalle`);
    await page.screenshot({ path: join(shots, '05-detail.png') });
    await dlg.getByRole('button', { name: 'Cerrar' }).last().click();
  });

  await step('savings screen explains capacity and scenarios', async () => {
    await page.getByRole('button', { name: 'Ahorro' }).first().click();
    await page.getByRole('heading', { name: 'Capacidad de ahorro estimada' }).waitFor();
    await page.getByText(/Estimación provisional/).first().waitFor();
    for (const s of ['Situación actual', 'Reducción moderada', 'Objetivo personal']) await page.getByText(s, { exact: true }).first().waitFor();
    await page.screenshot({ path: join(shots, '06-savings.png'), fullPage: true });
  });

  await step('demo data: recommendations, recurring and analytics', async () => {
    await page.getByRole('button', { name: 'Ajustes' }).click();
    await btn('Cargar 12 meses de datos ficticios').click();
    await page.getByText(/Datos de demostración cargados/).waitFor();
    await page.getByRole('button', { name: 'Resumen' }).click();
    await page.getByRole('heading', { name: 'Recomendaciones' }).waitFor();
    await page.locator('.reco').first().waitFor();
    await page.screenshot({ path: join(shots, '07-dashboard-demo.png'), fullPage: true });
    await page.getByRole('button', { name: 'Recurrentes' }).click();
    await page.getByRole('button', { name: 'Netflix' }).waitFor();
    await page.screenshot({ path: join(shots, '08-recurring.png'), fullPage: true });
    await page.getByRole('button', { name: 'Análisis' }).click();
    await page.getByRole('heading', { name: 'Patrones observados' }).waitFor();
    await page.screenshot({ path: join(shots, '09-analytics.png'), fullPage: true });
  });

  await step('import a CaixaBank Excel export (other bank)', async () => {
    await page.getByRole('button', { name: 'Documentos' }).first().click();
    await stubOpen([caixa]);
    await page.locator('.page-header').getByRole('button', { name: 'Importar documento' }).click();
    await page.getByText(/2 movimientos importados/).waitFor({ timeout: 20000 });
    await page.getByText('CaixaBank / imagin').first().waitFor();
  });

  await step('savings goals and emergency fund', async () => {
    await page.getByRole('button', { name: 'Metas' }).click();
    await page.getByRole('heading', { name: 'Metas de ahorro' }).waitFor();
    await page.getByText(/meses de gasto esencial|meses$/).first().waitFor();
    await page.getByText(/Viaje a Japón/).first().waitFor();
    await page.screenshot({ path: join(shots, '11-goals.png'), fullPage: true });
    await btn('Nueva meta').click();
    await page.getByRole('dialog').getByLabel('Nombre', { exact: true }).fill('Coche nuevo');
    await page.getByRole('dialog').getByLabel('Objetivo', { exact: true }).fill('6.000');
    await page.getByRole('dialog').getByRole('button', { name: 'Guardar' }).click();
    await page.getByRole('article', { name: 'Coche nuevo' }).waitFor();
  });

  await step('accounts: balances, manual remunerated account and transfer review', async () => {
    await page.getByRole('button', { name: 'Cuentas', exact: true }).click();
    await page.getByRole('heading', { name: 'Cuentas', exact: true }).waitFor();
    await page.getByRole('article', { name: 'Cuenta nómina (demo)' }).waitFor();
    await page.getByRole('article', { name: 'Cuenta remunerada (demo)' }).getByText('Destino de tus traspasos').waitFor();
    await page.getByRole('heading', { name: 'Revisa tus transferencias' }).waitFor();
    await page.screenshot({ path: join(shots, '14-accounts.png'), fullPage: true });
    await page.locator('.page-header').getByRole('button', { name: 'Añadir cuenta manual' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Nombre', { exact: true }).fill('Hucha naranja');
    await d.getByLabel('Saldo', { exact: true }).fill('1.000');
    await d.getByLabel('Rentabilidad (TAE, opcional)').fill('2');
    await d.getByRole('button', { name: 'Guardar' }).click();
    await page.getByRole('article', { name: 'Hucha naranja' }).getByText(/1\.000,00/).waitFor();
  });

  await step('profile tailors the emergency cushion', async () => {
    await page.getByRole('button', { name: 'Ajustes' }).click();
    await page.getByRole('heading', { name: 'Tu perfil' }).waitFor();
    await page.getByLabel('Tus ingresos').selectOption('self_employed');
    await page.getByLabel('Personas a tu cargo').fill('1');
    await page.getByRole('button', { name: 'Guardar perfil' }).click();
    await page.getByText(/Perfil guardado/).waitFor();
    await page.getByRole('button', { name: 'Ahorro' }).first().click();
    await page.getByRole('heading', { name: 'Adónde va tu dinero' }).waitFor();
    await page.getByRole('heading', { name: 'Referencia 50/30/20' }).waitFor();
    await page.getByText('Para ti: 7 meses de gasto esencial').waitFor();
    await page.getByRole('heading', { name: 'Sugerencias para ahorrar' }).waitFor();
    await page.screenshot({ path: join(shots, '15-savings-plus.png'), fullPage: true });
  });

  await step('budgets: suggestion from history, progress and alerts', async () => {
    await page.getByRole('heading', { name: 'Presupuestos del mes' }).waitFor();
    const card = page.locator('#budgets');
    const summary = card.getByText('Sugerencias según tus últimos 3 meses');
    if (!(await card.locator('details[open]').count())) await summary.click();
    await card.getByRole('button', { name: /^Usar / }).first().click();
    await card.locator('.bar-row').first().waitFor();
    await page.screenshot({ path: join(shots, '16-budgets.png'), fullPage: true });
  });

  await step('app lock with PIN: locks, refuses a wrong PIN, unlocks', async () => {
    await page.getByRole('button', { name: 'Ajustes' }).click();
    await page.getByRole('heading', { name: 'Seguridad', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Activar bloqueo con PIN' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Nuevo PIN (4–8 cifras)').fill('2468');
    await d.getByLabel('Repite el PIN').fill('2468');
    const hello = d.getByLabel('Permitir también Windows Hello');
    if (await hello.count()) await hello.uncheck();
    await d.getByRole('button', { name: 'Guardar' }).click();
    await page.getByText('Bloqueo activado.').first().waitFor();
    await page.getByRole('button', { name: 'Bloquear ahora' }).click();
    await page.getByRole('heading', { name: 'Hormiga está bloqueada' }).waitFor();
    // While locked, the main process refuses data requests even if the page asks directly.
    const probe = await page.evaluate(() => window.hormiga.invoke('transactions.list', {}).then(() => 'ok', (e) => e.code));
    if (probe !== 'LOCKED') throw new Error(`Datos accesibles con la app bloqueada: ${probe}`);
    await page.screenshot({ path: join(shots, '17-locked.png') });
    await page.getByLabel('PIN').fill('1111');
    await page.getByRole('button', { name: 'Desbloquear' }).click();
    await page.getByText('PIN incorrecto.').waitFor();
    await page.getByLabel('PIN').fill('2468');
    await page.getByRole('button', { name: 'Desbloquear' }).click();
    await page.getByRole('heading', { name: 'Ajustes' }).first().waitFor();
    // Turn it off again for the rest of the run.
    await page.getByRole('button', { name: 'Desactivar bloqueo' }).click();
    const off = page.getByRole('dialog');
    await off.getByLabel('PIN actual').fill('2468');
    await off.getByRole('button', { name: 'Desactivar' }).click();
    await page.getByRole('button', { name: 'Activar bloqueo con PIN' }).waitFor();
  });

  await step('wealth and simulator', async () => {
    await page.getByRole('button', { name: 'Patrimonio' }).click();
    await page.getByText('Patrimonio neto').first().waitFor();
    await page.getByRole('heading', { name: 'Simulador de ahorro e interés compuesto' }).waitFor();
    const txt = await page.locator('.hero').innerText();
    if (!/€/.test(txt)) throw new Error('Sin patrimonio neto');
    await page.screenshot({ path: join(shots, '12-wealth.png'), fullPage: true });
  });

  await step('mortgage: amortization schedule and early repayment', async () => {
    const row = page.getByRole('row').filter({ hasText: 'Hipoteca (demo)' });
    await row.getByText('Estimado').waitFor();
    await row.getByRole('button', { name: 'Ver préstamo' }).click();
    const d = page.getByRole('dialog');
    await d.getByText('Cuota mensual').waitFor();
    await d.getByRole('heading', { name: 'Cuadro de amortización' }).waitFor();
    await d.getByLabel('Importe a amortizar').fill('10.000');
    await d.getByRole('button', { name: 'Simular', exact: true }).click();
    await d.getByText(/Ahorrarías .* en intereses/).waitFor();
    await page.screenshot({ path: join(shots, '13-mortgage.png'), fullPage: true });
    await d.getByRole('button', { name: 'Cerrar' }).last().click();
  });

  await step('remunerated account estimated by annual rate', async () => {
    await page.locator('.page-header').getByRole('button', { name: 'Añadir activo o deuda' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Nombre', { exact: true }).fill('Cuenta naranja');
    await d.getByLabel('Tipo', { exact: true }).selectOption('deposit');
    await d.getByRole('button', { name: 'Estimar con rentabilidad anual' }).click();
    await d.getByLabel('Rentabilidad anual (TAE)').fill('2,5');
    await d.getByLabel('Aportación mensual (opcional)').fill('100');
    await d.getByLabel('Valor en la fecha').fill('5.000');
    await d.getByRole('button', { name: 'Guardar' }).click();
    const row = page.getByRole('row').filter({ hasText: 'Cuenta naranja' });
    await row.getByText(/2,50\s%\sanual\s\+\s100,00\s€\/mes/).waitFor();
  });

  await step('past returns lookup is opt-in (nothing sent before consent)', async () => {
    await page.getByRole('button', { name: 'usar una histórica' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Buscar valor').fill('MSCI World');
    await d.getByRole('button', { name: 'Buscar', exact: true }).click();
    await d.getByText(/La consulta a internet está desactivada/).waitFor();
    await d.getByRole('button', { name: 'Cerrar' }).last().click();
  });

  await step('export CSV', async () => {
    const out = join(work, 'movimientos.csv');
    await page.getByRole('button', { name: 'Ajustes' }).click();
    await stubSave(out);
    await btn('Exportar movimientos (CSV)').click();
    await page.getByText(/Movimientos exportados/).waitFor();
    const csv = readFileSync(out, 'utf8');
    if (!csv.includes('fecha;fecha_valor;descripcion_original') || !csv.includes('COMPRA TARJ. MERCADONA 1234 MADRID')) throw new Error('CSV incompleto');
  });

  await step('backup is a valid Hormiga database', async () => {
    const out = join(work, 'copia.hormiga-backup');
    await stubSave(out);
    await btn('Exportar copia de seguridad').click();
    await page.getByText(/Copia guardada/).waitFor();
    if (!existsSync(out)) throw new Error('No se creó la copia');
    const db = new DatabaseSync(out, { readOnly: true });
    const n = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
    const appId = db.prepare("SELECT value FROM app_meta WHERE key = 'app_id'").get().value;
    db.close();
    if (appId !== 'hormiga' || n < 400) throw new Error(`Copia inesperada: ${appId} ${n}`);
  });

  await step('dark theme renders', async () => {
    await page.getByRole('group', { name: 'Tema' }).getByRole('button', { name: 'Oscuro' }).click();
    await page.getByRole('button', { name: 'Resumen' }).click();
    await page.locator('.reco').first().waitFor();
    await page.screenshot({ path: join(shots, '10-dark.png'), fullPage: true });
  });

  await step('clear loaded data keeps goals and wealth', async () => {
    await page.getByRole('button', { name: 'Ajustes' }).click();
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    await btn('Borrar datos cargados…').click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Escribe BORRAR para confirmar').fill('BORRAR');
    await d.getByRole('button', { name: 'Borrar datos cargados' }).click();
    await page.getByText(/Borrados \d+ movimientos/).waitFor();
    await page.getByRole('button', { name: 'Movimientos', exact: true }).click();
    await page.getByText(/No tienes movimientos todavía/).first().waitFor();
    await page.getByRole('button', { name: 'Metas' }).click();
    await page.getByRole('article', { name: 'Coche nuevo' }).waitFor();
    await page.getByRole('button', { name: 'Patrimonio' }).click();
    await page.getByText('Cuenta naranja').waitFor();
  });

  await step('no renderer errors', async () => {
    const relevant = errors.filter((e) => !/Autofill|DevTools/.test(e));
    if (relevant.length) throw new Error(relevant.join(' | '));
  });

  await step('logs contain no financial data', async () => {
    const log = readFileSync(join(userData, 'logs', 'hormiga.log'), 'utf8');
    for (const forbidden of ['MERCADONA', '1.333,26', '133326', 'Novedades']) if (log.includes(forbidden)) throw new Error(`El log contiene «${forbidden}»`);
  });
} finally {
  await app.close().catch(() => {});
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} pasos correctos. Capturas: ${shots}`);
  rmSync(work, { recursive: true, force: true });
  process.exitCode = failed.length || results.length === 0 ? 1 : 0;
}
