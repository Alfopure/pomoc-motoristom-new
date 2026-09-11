/**
 * Capture the real React interface with synthetic fixtures and no app server.
 * Run: node scripts/capture-guide-screenshots.mjs [screenshot-id ...]
 * Every request is intercepted; mutations, external HTTP and WebSockets are blocked.
 * Never load deployment credentials, seed a database, place a call or send SMS.
 */
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import tailwindcss from '@tailwindcss/postcss';

const sharp = createRequire(import.meta.resolve('next/package.json'))('sharp');
const postcss = createRequire(import.meta.resolve('@tailwindcss/postcss'))('postcss');
const origin = 'https://guide-capture.test';
const out = path.resolve('public/guide-assets');
const scratch = path.resolve('.context/guide-capture');
await mkdir(out, { recursive: true });
await mkdir(scratch, { recursive: true });
const bundle = await build({ entryPoints: ['e2e/fixtures/guide-application.tsx'], outfile: `${scratch}/fixture.js`, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env': JSON.stringify({ NODE_ENV: 'production' }) } });
const script = bundle.outputFiles.find(f => f.path.endsWith('.js')).text;
const css = (bundle.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? '') + (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile('src/app/globals.css', 'utf8'), { from: path.resolve('src/app/globals.css') })).css;
const headRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirtySource = execFileSync('git', ['status', '--porcelain', '--', 'src/components', 'src/app/globals.css', 'e2e/fixtures/guide-application.tsx'], { encoding: 'utf8' }).trim();
const sourceRevision = `${headRevision}${dirtySource ? '+working-tree' : ''}`;
const capturedAt = new Date().toISOString();
const report = { sourceRevision, capturedAt, fixture: 'e2e/fixtures/guide-application.tsx', captures: [], errors: [], blockedRequests: [], rejectedMutations: [] };
const browser = await chromium.launch({ executablePath: process.env.GUIDE_CHROME_PATH ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'sk-SK', timezoneId: 'Europe/Bratislava', serviceWorkers: 'block', reducedMotion: 'reduce' });
await context.routeWebSocket('**/*', socket => { report.blockedRequests.push(`websocket:${socket.url()}`); socket.close(); });
await context.route('**/*', async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== origin) { report.blockedRequests.push(url.origin); return route.abort(); }
  if (!['GET', 'HEAD'].includes(request.method())) { report.rejectedMutations.push({ method: request.method(), path: url.pathname }); return route.fulfill({ status: 409, json: { error: 'Ukážka návodu: ukladanie a volanie je vypnuté.' } }); }
  if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="sk"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>' });
  const payload = await request.frame().page().evaluate(pathname => window.guideResponses?.[pathname], url.pathname).catch(() => undefined);
  if (payload !== undefined) return route.fulfill({ json: payload });
  report.blockedRequests.push(url.pathname);
  return route.fulfill({ status: 503, json: { error: 'Služba nie je súčasťou izolovanej ukážky.' } });
});
const shots = [];
const filters = new Set(process.argv.slice(2));
let activePage;
async function open(scenario = 'console', mobile = false) {
  if (activePage) await activePage.close();
  const page = await context.newPage(); activePage = page;
  page.setDefaultTimeout(8000);
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-09-11T09:30:00.000Z'));
  page.on('pageerror', error => { report.errors.push({ scenario, error: error.message }); console.error('PAGE ERROR', error.stack); });
  await page.goto(`${origin}/?scenario=${scenario}`);
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  if (!['console', 'login'].includes(scenario)) await page.setViewportSize({ width: 1100, height: ({ 'incoming-call': 300, 'active-call': 320, transfer: 650, queue: 410, callbacks: 700, pause: 760, sms: 900 })[scenario] ?? 650 });
  await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
  await page.locator('#root > *').waitFor();
  if (scenario === 'console') { await page.locator('[data-testid="dispatch-console"][data-hydrated="true"]').waitFor(); if (!mobile) await page.getByRole('button', { name: 'Maximalizovať kokpit', exact: true }).filter({ visible: true }).click(); }
  return page;
}
async function navigate(page, name) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('dialog', { name: 'Obrazovky aplikácie' }).getByRole('button', { name: new RegExp(`^${name}(?:\\s*\\d+)?$`) }).first().click();
}
async function settings(page, tab) {
  await navigate(page, 'Nastavenia');
  await page.getByRole('navigation', { name: 'Sekcie nastavení' }).getByRole('button', { name: 'Telefonovanie' }).click();
  const nav = page.getByRole('navigation', { name: 'Nastavenia telefónie' });
  await nav.getByRole('button', { name: tab, exact: true }).click();
  await page.getByText('Načítavam', { exact: false }).first().waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
}
async function capture(id, title, alt, setup, targets = []) {
  if (filters.size && !filters.has(id)) return;
  try {
    const page = await setup();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(180);
    const screenshot = await page.screenshot({ animations: 'disabled' });
    const { width, height } = await sharp(screenshot).metadata();
    const annotations = [];
    for (let index = 0; index < targets.length; index++) {
      const [key, label, locate] = targets[index];
      const locator = locate(page).filter({ visible: true }).first();
      const box = await locator.boundingBox();
      if (!box || box.width === 0 || box.height === 0 || box.y >= height || box.x >= width || box.y + box.height <= 0) throw new Error(`Annotation target ${key} is not visible`);
      const x = Math.max(0, box.x - 4), y = Math.max(0, box.y - 4);
      annotations.push({ id: `${id}-${key}`, label, x: round(x / width * 100), y: round(y / height * 100), width: round(Math.min(width - x, box.width + 8) / width * 100), height: round(Math.min(height - y, box.height + 8) / height * 100) });
    }
    await sharp(screenshot).webp({ quality: 90, effort: 5 }).toFile(`${out}/${id}.webp`);
    const entry = { id, file: `${id}.webp`, title, alt, width, height, annotations, scenario: 'Skutočné komponenty aplikácie s izolovanými ukážkovými údajmi; žiadne spojenie so službami.', capturedAt, sourceRevision };
    shots.push(entry); report.captures.push(id); console.log(`Captured ${id}: ${width}×${height}, ${annotations.length} annotations`);
  } catch (error) {
    report.errors.push({ screenshot: id, error: error.message }); console.error(`FAILED ${id}: ${error.message}`);
    if (activePage) { await writeFile(`${scratch}/${id}-error.txt`, await activePage.locator('body').innerText()); await activePage.screenshot({ path: `${scratch}/${id}-error.png` }).catch(() => {}); }
  }
}
function round(value) { return Math.round(value * 100) / 100; }
const button = name => page => page.getByRole('button', { name, exact: true });
const text = value => page => page.getByText(value, { exact: true });
try {
 await capture('login', 'Prihlásenie pracovným účtom', 'Prihlasovací formulár s e-mailom, heslom a obnovou hesla.', () => open('login'), [['email', 'Pracovný e-mail', p => p.getByLabel('Email', { exact: true })], ['password', 'Heslo účtu', p => p.getByLabel('Heslo', { exact: true })], ['recovery', 'Obnovenie zabudnutého hesla', p => p.getByRole('link', { name: 'Zabudnuté heslo' })]]);
 await capture('overview', 'Nástenka dispečera', 'Hlavná pracovná plocha s prípadmi, pracovnými nástrojmi a navigáciou.', () => open(), [['navigation', 'Hlavné obrazovky a menu', button('Menu')], ['cases', 'Zoznam aktívnych prípadov', p => p.getByText('Aktívne prípady', { exact: true })]]);
 await capture('menu-mobile', 'Navigácia na mobile', 'Otvorené menu aplikácie pri šírke mobilného telefónu.', async () => { const p = await open('console', true); await p.getByRole('button', { name: 'Menu', exact: true }).click(); return p; }, [['shortcuts', 'Skratky obrazoviek na mobile', p => p.getByText('SKRATKY V SPODNEJ LIŠTE', { exact: false })], ['cases', 'Prechod na prípady', p => p.getByRole('button', { name: 'Prípady', exact: true }).filter({ visible: true }).first()]]);
 const settingsShots = [
  ['phone-settings', 'Môj telefón', 'Vlastná dostupnosť, spôsob prijímania hovorov a nastavenia zvuku.', [['presence', 'Vlastná dostupnosť', button('Som dostupný')], ['delivery', 'Výber zvukového zariadenia', p => p.getByText('Zvukový výstup', { exact: true })]]],
  ['groups', 'Skupiny', 'Členovia skupiny, poradie a individuálny čas zvonenia.', [['name', 'Názov skupiny', p => p.locator('input[value="Dispečing — denná služba"]')], ['members', 'Vlastný čas člena platí len pri postupnom zvonení', p => p.locator('input[value="20"]')]]],
  ['ring-plans', 'Plány zvonenia', 'Dva kroky zvonenia: najprv celý tím, potom záložná pozícia.', [['name', 'Názov plánu', p => p.locator('input[value="Hlavná linka — služba a záloha"]')], ['steps', 'Čas kroku pri zvonení všetkým naraz', p => p.locator('input[value="25"]')], ['fallback', 'Čo nasleduje, keď nikto nezdvihne', p => p.getByText('Keď nikto nezdvihne', { exact: false }).locator('..')]]],
  ['ivr', 'IVR menu', 'Voľby jednotka pre dispečing a dvojka pre spätné volanie.', [['name', 'Názov hlasového menu', p => p.locator('input[value="Hlavné hlasové menu"]')]]],
  ['hours', 'Otváracie hodiny', 'Týždenný rozvrh linky a časové pásmo.', [['schedule', 'Rozvrh otváracích hodín', p => p.locator('input[value="Pracovné dni 08:00 – 18:00"]')]]],
  ['numbers', 'Čísla', 'Priradenie plánu, IVR a otváracích hodín ku konkrétnej linke.', [['line', 'Výber konkrétnej linky', p => p.getByText('+421900000002', { exact: true })]]],
  ['announcements', 'Hlášky a jazyk', 'Výber linky, jazyka a hlášok pre volajúcich.', [['language', 'Jazyk hlášok', p => p.getByText('Jazyk hovoru', { exact: false })]]],
  ['recording', 'Nahrávanie a kvalita', 'Nastavenia nahrávania, prepisu a spracovania rozhovorov.', [['recording', 'Nahrávanie rozhovorov', p => p.getByLabel('Nahrávať hovory', { exact: false })], ['transcript', 'Nadväzujúci prepis', p => p.getByLabel('Vytvárať časový prepis', { exact: false })]]],
 ];
 for (const [id, tab, description, targets] of settingsShots) await capture(id, tab, description, async () => { const p = await open(); await settings(p, tab); if (['groups', 'ring-plans', 'ivr', 'hours'].includes(id)) await p.setViewportSize({ width: 1440, height: 1280 }); return p; }, targets);
 await capture('incoming-call', 'Prijatie prichádzajúceho hovoru', 'Prichádzajúci hovor z ukážkového telefónneho čísla s ovládaním prijatia.', () => open('incoming-call'), [['answer', 'Prijať ponúknutý hovor', button('Prijať')]]);
 await capture('active-call', 'Ovládanie hovoru', 'Panel prebiehajúceho hovoru s vypnutím mikrofónu, podržaním a ďalšími akciami.', () => open('active-call'), [['mute', 'Vypnutie vlastného mikrofónu', p => p.getByRole('button', { name: /Stlmiť/ })], ['hold', 'Podržanie zákazníka', p => p.getByRole('button', { name: /Podržať/ })]]);
 await capture('transfer', 'Prepojenie na kolegu', 'Výber dostupného kolegu alebo externého čísla pri prepojení hovoru.', () => open('transfer'), [['targets', 'Dostupnosť jednotlivých kolegov', p => p.getByRole('button', { name: /Martin Ukážkový/ })], ['number', 'Možnosť externého čísla', p => p.getByRole('textbox')]]);
 await capture('queue', 'Kto práve čaká na linke', 'Čakáreň s dvoma volajúcimi, časom čakania a vyzdvihnutím hovoru.', () => open('queue'), [['waiting', 'Čas a aktuálny stav volajúceho', text('Čaká na pridelenie')], ['pickup', 'Ručné prevzatie hovoru', p => p.getByRole('button', { name: 'Vyzdvihnúť' }).first()]]);
 await capture('callbacks', 'Požiadavky na spätné volanie', 'Otvorená požiadavka a požiadavka prevzatá ukážkovým dispečerom.', () => open('callbacks'), [['claim', 'Prevziať zodpovednosť za požiadavku', p => p.getByRole('button', { name: /Prevziať/ }).first()], ['call', 'Zavolať klientovi späť', p => p.getByRole('button', { name: 'Zavolať', exact: true }).first()]]);
 await capture('pause', 'Výber prestávky', 'Dialóg bežnej pauzy a zastupovania dostupným kolegom.', async () => { const p = await open('pause'); await p.getByRole('combobox').first().selectOption('pause-break'); return p; }, [['normal', 'Bežná pauza: plán pokračuje', p => p.getByText('Bežná pauza', { exact: true })], ['substitute', 'Zastupovanie kolegom', p => p.getByText('Zastúpi ma kolega', { exact: true })]]);
 await capture('cases', 'Vyhľadávanie prípadov', 'Register prípadov s vyhľadávaním, filtrami a históriou.', async () => { const p = await open(); await navigate(p, 'Prípady'); return p; }, [['history', 'Prepnutie do histórie', p => p.getByRole('button', { name: /^História/ })], ['search', 'Hľadanie prípadu', p => p.locator('input[placeholder]').filter({ visible: true }).first()]]);
 await capture('new-case', 'Založenie nového prípadu', 'Začiatok formulára nového prípadu a uloženie rozpracovanej karty.', async () => { const p = await open(); await p.getByRole('button', { name: /Nový prípad/ }).first().click(); return p; }, [['basics', 'Základné údaje prípadu', p => p.getByText('1. Základ prípadu', { exact: true })]]);
 await capture('case-detail', 'Karta prípadu', 'Detail ukážkového prípadu s údajmi zákazníka a vozidla.', async () => { const p = await open(); return p; }, [['client', 'Kontaktné údaje klienta', p => p.getByText('Klient — ukážka A', { exact: true }).first()]]);
 await capture('sms', 'SMS ku konkrétnemu prípadu', 'SMS formulár pred odoslaním, s adresátom a prepojením na prípad.', () => open('sms'), [['recipient', 'Prípad určuje kontakt príjemcu', p => p.getByRole('combobox').first()], ['message', 'Text správy', p => p.getByRole('textbox').last()]]);
 await capture('tasks', 'Prehľad úloh', 'Pracovná tabuľa s úlohami na dnes a naplánovanými úlohami.', async () => { const p = await open(); await navigate(p, 'Úlohy'); return p; }, [['today', 'Úlohy s dnešným termínom', p => p.locator('[data-task-column="today"] h3')], ['new', 'Vytvorenie samostatnej úlohy', p => p.getByRole('button', { name: /Nová úloha/ }).first()]]);
 await capture('notes', 'Osobná poznámka', 'Súkromná poznámka a voľba kolegov, ktorí ju môžu čítať.', async () => { const p = await open(); await navigate(p, 'Poznámky'); await p.getByRole('button', { name: /Odovzdanie služby — ukážka/ }).click(); await p.getByText('Zdieľať s kolegami (0)', { exact: false }).click(); return p; }, [['privacy', 'Súkromie a zdieľanie iba na čítanie', p => p.getByText('Zdieľať s kolegami (0)', { exact: false })], ['save', 'Stav uloženia poznámky', p => p.getByText('Uložené', { exact: true }).first()]]);
 await capture('notifications', 'Nastavenia upozornení', 'Typy upozornení a nastavenie zvuku pre zariadenie.', async () => { const p = await open(); await navigate(p, 'Nastavenia'); return p; }, [['section', 'Nastavenia upozornení', p => p.getByRole('navigation', { name: 'Sekcie nastavení' }).getByRole('button', { name: 'Upozornenia' })]]);
 await capture('attendance', 'Plánovanie dochádzky', 'Kalendár plánovaných smien s prepínaním na vlastnú dochádzku.', async () => { const p = await open(); await navigate(p, 'Dochádzka'); return p; }, [['mine', 'Moja dochádzka', button('Moja dochádzka')], ['requests', 'Žiadosti o neprítomnosť', button('Žiadosti')]]);
 await capture('fleet', 'Prehľad flotily', 'Náhradné vozidlá a odťahová technika so stavom dostupnosti.', async () => { const p = await open(); await navigate(p, 'Flotila'); return p; }, [['replacement', 'Náhradné vozidlá', button('Náhradné vozidlá')], ['tow', 'Odťahová technika', button('Odťahovky')]]);
 await capture('directory', 'Adresár kontaktov', 'Ukážkové kontakty na odťahovú službu, servis a asistenciu.', async () => { const p = await open(); await navigate(p, 'Nastavenia'); await p.getByRole('navigation', { name: 'Sekcie nastavení' }).getByRole('button', { name: 'Adresár' }).click(); await p.getByText('Odťahová služba — ukážka', { exact: true }).waitFor(); return p; }, [['search', 'Hľadanie kontaktov', p => p.locator('input[placeholder]').filter({ visible: true }).first()]]);
 await capture('reports', 'Prevádzkové reporty', 'Súhrn ukážkových hovorov a prípadov za vybrané obdobie.', async () => { const p = await open(); await navigate(p, 'Reporty'); await p.getByText('5. – 11. september 2026', { exact: true }).first().waitFor(); return p; }, [['categories', 'Kategórie reportov', p => p.getByRole('navigation', { name: 'Kategórie reportov' })], ['range', 'Obdobie reportu', button('7 dní')]]);
} finally {
 await browser.close();
 const manifestPath = 'src/content/guide/screenshots.json';
 const existing = filters.size ? JSON.parse(await readFile(manifestPath, 'utf8').catch(() => '[]')) : [];
 const merged = [...existing.filter(shot => !shots.some(fresh => fresh.id === shot.id)), ...shots];
 await writeFile(manifestPath, JSON.stringify(merged, null, 2) + '\n');
 await writeFile(`${scratch}/report.json`, JSON.stringify(report, null, 2));
 console.log(JSON.stringify({ captures: shots.length, errors: report.errors, blockedRequests: [...new Set(report.blockedRequests)], rejectedMutations: report.rejectedMutations }, null, 2));
 if (report.errors.length) process.exitCode = 1;
}
