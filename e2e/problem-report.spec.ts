import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] } });
let script: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ['e2e/fixtures/problem-report.tsx'], outfile: 'report.js', bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env': JSON.stringify({ NODE_ENV: 'production' }) } });
  script = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
});
for (const logout of [false, true]) test(`boundary report observes a late batch ACK${logout ? ' and ignores an old account response' : ''}`, async ({ page }) => {
  await page.clock.install();
  const batches: Array<Array<{ id: string; type: string; errorId?: string; caseId?: string }>> = [];
  let release!: () => void;
  const holdFirst = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/*', async route => {
    if (route.request().url() === 'https://report.test/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    if (route.request().url() !== 'https://report.test/api/diagnostics/events') return route.abort();
    const batch = route.request().postDataJSON().events;
    batches.push(batch);
    if (batches.length === 1) await holdFirst;
    return route.fulfill({ json: { acceptedIds: batch.map((item: { id: string }) => item.id) } });
  });
  await page.goto('https://report.test/'); await page.addScriptTag({ content: script });
  await expect.poll(() => batches.length).toBe(1);
  await page.getByRole('button', { name: 'Nahlásiť problém', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Prijatie zatiaľ nie je potvrdené.');
  if (logout) await page.evaluate(() => (window as unknown as { logoutReportFixture: () => void }).logoutReportFixture());
  release();
  await page.clock.runFor(10_000);
  if (logout) {
    await expect(page.getByRole('status')).toContainText('Skontrolujte prihlásenie');
    expect(batches).toHaveLength(1);
  } else {
    await expect(page.getByRole('status')).toContainText('Hlásenie bolo prijaté.');
    expect(batches).toHaveLength(2);
    expect(batches[1][0]).toMatchObject({ type: 'user_report', errorId: batches[0][0].errorId, caseId: '00000000-0000-4000-8000-000000000021' });
    expect(JSON.stringify(batches)).not.toContain('CANARY');
  }
});
