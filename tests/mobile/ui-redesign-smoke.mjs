// Run against the real Expo web app, using a browser-only synthetic transport.
// Start Metro with the public synthetic configuration described in the rollout doc.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const origin = process.env.MOBILE_QA_ORIGIN || 'http://localhost:8081';
assert(['localhost', '127.0.0.1'].includes(new URL(origin).hostname), 'Use an isolated local Expo build');
const out = resolve('.context/mobile-ui-qa');
mkdirSync(out, { recursive: true });
const report = { source: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), startedAt: new Date().toISOString(), synthetic: true, checks: [] };
let session = 'redesign-dispatch-qa';
function browser(...args) {
  const result = spawnSync('agent-browser', ['--session', session, '--json', ...args], { encoding: 'utf8', timeout: 45_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const reply = JSON.parse(result.stdout);
  assert(reply.success, JSON.stringify(reply.error));
  return reply.data;
}
const evaluate = code => browser('eval', code).result;
const role = (kind, name) => browser('find', 'role', kind, 'click', '--name', name, '--exact');
function click(selector) {
  evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`);
  browser('click', selector);
}
function check(name, value) { assert(value, name); report.checks.push(name); }
function capture(name) {
  check(`${name}: no horizontal overflow`, evaluate('document.documentElement.scrollWidth <= innerWidth'));
  const small = evaluate(`Array.from(document.querySelectorAll('[role="button"],[role="tab"],input')).filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'&&!e.closest('[aria-hidden="true"]')&&(r.width<43.5||r.height<43.5)}).map(e=>({label:e.getAttribute('aria-label')||e.innerText,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))`);
  check(`${name}: visible controls at least 44 points: ${JSON.stringify(small)}`, small.length === 0);
  browser('screenshot', resolve(out, `${name}.png`));
}
function signIn(field = false) {
  browser('--executable-path', '/usr/bin/google-chrome', 'open', '--init-script', resolve('tests/mobile/ui-redesign-fixture.js'), origin + (field ? '/?fixture=field' : '/'));
  browser('set', 'viewport', '390', '844');
  browser('wait', '[aria-label="E-mail"]');
  browser('fill', '[aria-label="E-mail"]', 'person@example.invalid');
  browser('fill', '[aria-label="Heslo"]', 'synthetic-password');
  role('button', 'Zobraziť heslo');
  check('password reveal preserves entered value', evaluate(`document.querySelector('[aria-label="Heslo"]').value==='synthetic-password'&&document.querySelector('[aria-label="Heslo"]').type==='text'`));
  role('button', 'Skryť heslo');
  capture(field ? 'field-login' : 'login');
  role('button', 'Prihlásiť sa');
  browser('wait', '--text', field ? 'Moja práca' : 'Treba riešiť');
}
try {
  signIn();
  for (const [width, height] of [[320, 568], [390, 844], [768, 1024]]) {
    browser('set', 'viewport', String(width), String(height));
    role('tab', 'Prehľad');
    capture(`home-${width}`);
    check(`home-${width}: urgent work before summaries`, evaluate(`document.body.innerText.indexOf('Treba riešiť')<document.body.innerText.indexOf('Vaša práca')`));
    role('tab', 'Moduly');
    capture(`modules-${width}`);
    browser('fill', '[aria-label="Hľadať modul"]', 'neexistujuci modul');
    browser('wait', '--text', 'Žiadny zodpovedajúci modul');
    check(`modules-${width}: search has explicit empty result`, evaluate(`document.body.innerText.includes('Žiadny zodpovedajúci modul')`));
    browser('fill', '[aria-label="Hľadať modul"]', '');
    role('tab', 'Prípady');
    browser('wait', '[aria-label^="Otvoriť prípad 2026-01428"]');
    click('[aria-label^="Otvoriť prípad 2026-01428"]');
    browser('wait', '[aria-label="Upraviť prípad"]');
    capture(`case-${width}`);
    role('button', 'Späť na Prípady');
    role('tab', 'Moje úlohy');
    browser('wait', '--text', 'Overiť pristavenie');
    capture(`tasks-${width}`);
  }
  role('tab', 'Moduly');
  role('button', 'Možnosti modulu Hovory');
  browser('wait', '--text', 'Odobrať z lišty');
  capture('module-options');
  browser('find', 'last', '[aria-label="Zavrieť"]', 'click');
  role('tab', 'Prehľad');
  evaluate(`__mobileFixture.mode='error'`);
  browser('wait', '16000'); // Let the real query cache become stale before remounting.
  role('tab', 'Moje úlohy');
  role('tab', 'Prehľad');
  browser('wait', '--text', 'Niektoré upozornenia');
  check('failed source never claims all work is finished', evaluate(`!document.body.innerText.includes('Všetko je vybavené')`));
  capture('source-error');

  session = 'redesign-field-qa';
  signIn(true);
  browser('wait', '--text', 'Požiadavky pobočky sa nepodarilo overiť');
  check('branch failure does not claim an empty queue', evaluate(`!document.body.innerText.includes('Nič nečaká na prevzatie')`));
  evaluate(`Array.from(document.querySelectorAll('[role="button"]')).find(e=>e.textContent.trim()==='Obnoviť prehľad')?.scrollIntoView({block:'center'})`);
  browser('find', 'role', 'button', 'click', '--name', 'Obnoviť prehľad', '--exact');
  browser('wait', '--text', 'Obnoviť prehľad');
  check('driver refresh preserves account and never reads unauthorized deliveries', evaluate(`document.body.innerText.includes('Účet')&&!__mobileFixture.requests.some(r=>r.path.endsWith('/field/deliveries'))`));
  capture('field-branch-error');
  report.finishedAt = new Date().toISOString();
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.message;
  throw error;
} finally {
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({status: report.status, checks: report.checks.length, report: resolve(out, 'report.json')}));
}
