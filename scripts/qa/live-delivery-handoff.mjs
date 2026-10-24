import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { chromium as playwright } from 'playwright-core';
import { expect } from '@playwright/test';
import chromium from '@sparticuz/chromium';
import { cleanupFixtures, provisionFixtures, validateQaEnv } from './live-delivery-core.mjs';

// Opt-in build check, never a public endpoint. Ordinary user sessions perform
// every handoff operation; the admin client only prepares and removes fixtures.
let stage = 'environment guards';
let config, fixtures, browser, context, qaPage;
let cleaning;
const clients = [];
const passed = [];
const browserErrors = [];
const failedResources = {};
const stopping = new AbortController();
class QaFailure extends Error {}
function check(value) { if (!value) throw new QaFailure('assertion'); }
function running() { if (stopping.signal.aborted) throw new QaFailure('interrupted'); }
function pass(name) { passed.push(name); console.log(JSON.stringify({ deliveryQa: 'passed', check: name })); }
async function responseJson(response, status = 200) {
  if (response.status !== status) throw new QaFailure(`HTTP ${response.status}, expected ${status}`);
  return response.json();
}
async function request(path, { token, method = 'GET', body, headers = {} } = {}) {
  running();
  check(path.startsWith('/api/mobile/v1/field/') || path === '/api/health/live' || path === '/api/health/ready');
  return fetch(`${config.origin}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { 'x-pm-app-environment': 'test', 'x-pm-expected-organization': config.organizationId,
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function loginActor(actor) {
  running();
  const client = createClient(config.supabaseUrl, config.publicKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }) },
  });
  clients.push(client);
  const result = await client.auth.signInWithPassword({ email: actor.email, password: actor.password });
  check(!result.error && result.data.user?.id === actor.userId && result.data.session?.access_token);
  actor.accessToken = result.data.session.access_token;
  running();
}
async function cleanup() {
  cleaning ??= (async () => {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    // Local SDK clients do not persist sessions or run refresh timers.
    for (const client of clients) client.auth.stopAutoRefresh();
    if (config) await cleanupFixtures(config, fixtures);
  })();
  return cleaning;
}
function stop(reason) {
  console.error(JSON.stringify({ deliveryQa: 'stopping', reason, stage }));
  stopping.abort();
  // Interrupt UI waits, but never race fixture setup with cleanup. The current
  // setup request settles, the abort guard prevents the next write, then the
  // main path reaches finally. A hard-killed build requires explicit recovery.
  void browser?.close().catch(() => {});
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop(signal));
const deadline = setTimeout(() => stop('deadline'), 240_000);

try {
  config = validateQaEnv(process.env);
  if (config.mode === 'cleanup') {
    stage = 'explicit cleanup';
    await cleanup();
  } else {
    stage = 'canonical deployment identity';
    const health = await responseJson(await request('/api/health/live'));
    check(health.status === 'live' && health.release?.environment === 'test' && health.release?.commit === config.expectedSha);
    check((await request('/api/health/ready')).status === 200);
    console.log(JSON.stringify({ deliveryQa: 'target', runId: config.runId, commit: config.expectedSha, deployment: health.version }));

    stage = 'isolated fixture setup';
    fixtures = await provisionFixtures(config, { signal: stopping.signal });
    running();
    stage = 'ordinary mobile sign-in';
    await loginActor(fixtures.recipient);
    await loginActor(fixtures.outsider);
    pass('ordinary field accounts sign in');

    stage = 'ordinary browser sign-in';
    const executablePath = process.env.DIAGNOSTICS_CHROMIUM_PATH || await chromium.executablePath();
    running();
    // The browser child receives no admin, provider or deployment credentials.
    const browserEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LD_LIBRARY_PATH'].flatMap(key =>
      process.env[key] ? [[key, process.env[key]]] : []));
    browser = await playwright.launch({ executablePath, args: chromium.args, headless: true, env: browserEnv });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin === config.supabaseUrl && url.pathname.startsWith('/auth/v1/')) return route.continue();
      if (url.origin !== config.origin || url.pathname.startsWith('/api/telephony/')) return route.abort();
      // Only this fixture's handoff is writable through the UI. Phone/SMS,
      // presence, account settings and unrelated cases cannot be mutated.
      if (!['GET', 'HEAD'].includes(req.method()) &&
        !(req.method() === 'POST' && url.pathname === `/api/cases/${fixtures.case.id}/handoffs`)) return route.abort();
      return route.continue();
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    qaPage = page;
    page.on('pageerror', error => {
      // Only classifications and owned chunk names; never arbitrary messages.
      const react = /Minified React error #(\d+)/.exec(error.message);
      const chunk = /\/_next\/static\/chunks\/[a-zA-Z0-9_.-]+\.js/.exec(error.stack ?? '');
      if (browserErrors.length < 10) browserErrors.push({
        kind: ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(error.name) ? error.name : 'other',
        ...(react ? { reactCode: react[1] } : {}), ...(chunk ? { chunk: chunk[0] } : {}),
      });
    });
    page.on('requestfailed', req => {
      const url = new URL(req.url());
      const kind = url.origin === config.supabaseUrl ? (url.pathname.startsWith('/auth/v1/') ? 'auth' : 'supabase-other')
        : url.origin === config.origin ? (url.pathname.startsWith('/_next/') ? 'app-assets' : 'app-request') : 'external';
      failedResources[kind] = (failedResources[kind] ?? 0) + 1;
    });
    page.setDefaultTimeout(30_000);
    await page.goto(config.origin, { waitUntil: 'domcontentloaded' });
    stage = 'interactive login form';
    const emailInput = page.getByRole('textbox', { name: 'Email', exact: true });
    const forgotPassword = `/auth/forgot-password?${new URLSearchParams({ email: fixtures.dispatcher.email })}`;
    // SSR inputs may be visible before React attaches handlers. The link is
    // derived from React's email state, so its update proves interactivity.
    await expect(async () => {
      await emailInput.fill('');
      await emailInput.fill(fixtures.dispatcher.email);
      await expect(page.getByRole('link', { name: 'Zabudnuté heslo', exact: true }))
        .toHaveAttribute('href', forgotPassword, { timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    const closeInstall = page.getByRole('button', { name: 'Zavrieť ponuku inštalácie', exact: true });
    if (await closeInstall.isVisible()) await closeInstall.click();
    await page.getByLabel('Heslo', { exact: true }).fill(fixtures.dispatcher.password);
    stage = 'browser password exchange';
    const signInResponse = page.waitForResponse(response =>
      response.url().startsWith(`${config.supabaseUrl}/auth/v1/token`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Prihlásiť sa', exact: true }).click();
    const signedIn = await signInResponse;
    if (!signedIn.ok()) throw new QaFailure(`auth HTTP ${signedIn.status()}`);
    const session = await signedIn.json();
    check(session.user?.id === fixtures.dispatcher.userId && session.access_token);
    fixtures.dispatcher.accessToken = session.access_token;
    pass('browser password exchange');
    stage = 'persisted browser session';
    await expect.poll(async () => (await context.cookies(config.origin))
      .some(cookie => /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name)), { timeout: 15_000 }).toBe(true);
    // The password response precedes the SDK's cookie write and redirect.
    // Start the workspace from its persisted ordinary session, without racing
    // those async callbacks or manufacturing authentication cookies.
    await page.goto(config.origin, { waitUntil: 'domcontentloaded' });
    stage = 'interactive dispatcher workspace';
    await expect(page.getByTestId('dispatch-console')).toHaveAttribute('data-hydrated', 'true', { timeout: 60_000 });
    await page.getByRole('textbox', { name: 'Hľadať podľa čísla prípadu, telefónu, EČV alebo mesta', exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 });
    check(fixtures.dispatcher.accessToken);
    pass('dispatcher browser login with ordinary SSR cookies');

    stage = 'handoff access boundaries';
    const handoffPath = `/api/cases/${fixtures.case.id}/handoffs`;
    check((await fetch(`${config.origin}${handoffPath}`, { redirect: 'error', signal: AbortSignal.timeout(20_000) })).status === 401);
    check((await context.request.post(`${config.origin}${handoffPath}`, {
      headers: { origin: 'https://invalid.example', 'content-type': 'application/json' }, data: { action: 'issue' },
    })).status() === 403);
    const empty = await responseJson(await request('/api/mobile/v1/field/deliveries', { token: fixtures.recipient.accessToken }));
    check(Array.isArray(empty.deliveries) && empty.deliveries.length === 0);
    pass('web authentication, CSRF and empty private work list');

    stage = 'find own case in web list';
    await page.getByRole('textbox', { name: 'Hľadať podľa čísla prípadu, telefónu, EČV alebo mesta', exact: true }).fill(fixtures.case.caseNumber);
    stage = 'open own case detail';
    await page.getByRole('button', { name: `Detail prípadu ${fixtures.case.caseNumber}`, exact: true }).click();
    stage = 'expand handoff panel';
    await page.getByRole('button', { name: /Odovzdať prípad/ }).click();
    stage = 'select app recipient';
    await page.getByRole('combobox', { name: 'Príjemca odovzdania', exact: true }).selectOption(fixtures.recipient.memberId);
    await page.getByRole('textbox', { name: /^Telefón pristavovača/ }).fill(fixtures.contact.phone);
    stage = 'issue handoff from web';
    const issuedResponse = page.waitForResponse(response => new URL(response.url()).pathname === handoffPath && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Odovzdať do aplikácie', exact: true }).click();
    const issued = await issuedResponse;
    check(issued.ok());
    const receipt = await issued.json();
    check(receipt.delivery?.status === 'sent' && receipt.delivery.memberId === fixtures.recipient.memberId && receipt.handoff?.id);
    await page.getByText('V aplikácii', { exact: true }).waitFor({ state: 'visible' });
    const handoffId = receipt.handoff.id;
    pass('web selector sends confirmed handoff into recipient app');

    stage = 'recipient and outsider visibility';
    const fieldPath = `/api/mobile/v1/field/deliveries/${handoffId}`;
    const list = await responseJson(await request('/api/mobile/v1/field/deliveries', { token: fixtures.recipient.accessToken }));
    check(list.deliveries.length === 1 && list.deliveries[0].id === handoffId && list.deliveries[0].card?.caseNumber === fixtures.case.caseNumber);
    const otherList = await responseJson(await request('/api/mobile/v1/field/deliveries', { token: fixtures.outsider.accessToken }));
    check(otherList.deliveries.length === 0);
    check([403, 404].includes((await request(fieldPath, { token: fixtures.outsider.accessToken })).status));
    check((await request(fieldPath, { token: fixtures.recipient.accessToken, headers: { 'x-pm-app-environment': 'production' } })).status === 409);
    pass('only assigned member sees card; wrong environment is refused');

    let delivery = (await responseJson(await request(fieldPath, { token: fixtures.recipient.accessToken }))).delivery;
    async function command(action) {
      const body = { commandId: randomUUID(), action, expectedRevision: delivery.revision, publishedVersion: delivery.publishedVersion };
      const result = await responseJson(await request(`${fieldPath}/commands`, { token: fixtures.recipient.accessToken, method: 'POST', body }));
      check(result.commandId === body.commandId && result.committedRevision === body.expectedRevision + 1);
      delivery = result.delivery;
      return { body, result };
    }
    stage = 'accept and idempotent replay';
    const accepted = await command('accept');
    check(delivery.status === 'accepted');
    const replay = await responseJson(await request(`${fieldPath}/commands`, { token: fixtures.recipient.accessToken, method: 'POST', body: accepted.body }));
    check(replay.commandId === accepted.result.commandId && replay.committedRevision === accepted.result.committedRevision);
    pass('recipient accepts once; command replay remains idempotent');

    stage = 'travel and synthetic GPS';
    await command('en_route');
    check(delivery.status === 'en_route');
    const position = { lat: 48.153, lng: 17.109, accuracy: 12, recordedAt: new Date().toISOString() };
    const stored = await responseJson(await request(`${fieldPath}/position`, { token: fixtures.recipient.accessToken, method: 'POST', body: position }));
    check(stored.active === true && stored.stored === true);
    const tracking = await responseJson(await request(`${fieldPath}/tracker`, { token: fixtures.recipient.accessToken, method: 'POST' }));
    check(typeof tracking.token === 'string' && tracking.token.length === 43);
    const webContext = await context.request.get(`${config.origin}${handoffPath}`);
    check(webContext.ok());
    const webData = await webContext.json();
    const appHandoff = webData.handoffs.find(item => item.id === handoffId);
    check(appHandoff?.status === 'en_route' && appHandoff.app?.lastPosition?.lat === position.lat);
    // Polling renders the live response in the actual web panel.
    await page.locator('.handoff-grant [data-status="en_route"]').waitFor({ state: 'visible', timeout: 45_000 });
    await page.getByRole('link', { name: 'Ukázať pristavovača na mape' }).waitFor({ state: 'visible' });
    pass('en-route state and synthetic GPS return to the web');

    stage = 'arrival and completion privacy';
    await command('arrived');
    check(delivery.status === 'arrived');
    await command('complete');
    check(delivery.status === 'completed' && delivery.card === null && delivery.tracking === false);
    const closedTrack = await responseJson(await request('/api/mobile/v1/field/track', {
      method: 'POST', headers: { authorization: `Tracker ${tracking.token}` }, body: { positions: [position] },
    }));
    check(closedTrack.active === false && closedTrack.stored === 0);
    await page.locator('.handoff-grant [data-status="completed"]').waitFor({ state: 'visible', timeout: 45_000 });
    check(await page.getByRole('link', { name: 'Ukázať pristavovača na mape' }).count() === 0);
    pass('arrived/completed lifecycle hides card and stops tracking');

    stage = 'fixture cleanup';
    await cleanup();
    pass('temporary case, memberships, profiles and Auth users removed');
    stage = 'final canonical deployment identity';
    const finalHealth = await responseJson(await request('/api/health/live'));
    check(finalHealth.release?.commit === config.expectedSha && finalHealth.release?.environment === 'test');
    console.log(JSON.stringify({ deliveryQa: 'complete', runId: config.runId, commit: config.expectedSha, checks: passed,
      limitations: ['no physical iPhone', 'no push delivery', 'synthetic GPS only', 'telephony excluded'] }));
  }
} catch (error) {
  // Browser/SDK errors can contain URLs, tokens or customer data. Report only
  // the fixed stage label; the fixture journal provides recovery identifiers.
  const reason = error instanceof QaFailure ? error.message
    : /^Delivery QA [a-zA-Z_ :;-]+(?: failed \([a-zA-Z0-9_]+\))?$/.test(error?.message ?? '') ? error.message
      : error?.name === 'TimeoutError' ? 'browser timeout' : 'request or fixture check failed';
  console.error(JSON.stringify({ deliveryQa: 'failed', stage, reason }));
  if (qaPage && !qaPage.isClosed()) {
    try {
      console.error(JSON.stringify({ deliveryQa: 'browser-state',
        loginVisible: await qaPage.getByRole('heading', { name: 'Prihlásenie', exact: true }).isVisible(),
        errorBoundaryVisible: await qaPage.getByRole('heading', { name: 'Obrazovku sa nepodarilo zobraziť', exact: true }).isVisible(),
        documentState: await qaPage.evaluate(() => document.readyState),
        consoleLayout: await qaPage.getByTestId('dispatch-console').evaluate(element => {
          const ancestors = [];
          for (let node = element; node && ancestors.length < 6; node = node.parentElement) {
            const style = getComputedStyle(node), rect = node.getBoundingClientRect();
            ancestors.push({ tag: node.tagName, hidden: node.hidden, display: style.display, visibility: style.visibility,
              contentVisibility: style.contentVisibility, width: rect.width, height: rect.height });
          }
          return ancestors;
        }, undefined, { timeout: 1_000 }).catch(() => []),
        consoleCount: await qaPage.getByTestId('dispatch-console').count(),
        hydrated: await qaPage.getByTestId('dispatch-console').getAttribute('data-hydrated', { timeout: 1_000 }).catch(() => null),
        authCookieParts: (await context.cookies(config.origin)).filter(cookie => /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name)).length,
        browserErrors, failedResources,
      }));
    } catch { /* Diagnostics must not prevent deterministic cleanup. */ }
  }
  process.exitCode = 1;
} finally {
  try { await cleanup(); }
  catch { console.error(JSON.stringify({ deliveryQa: 'cleanup-required', runId: config?.runId })); process.exitCode = 2; }
  clearTimeout(deadline);
}
