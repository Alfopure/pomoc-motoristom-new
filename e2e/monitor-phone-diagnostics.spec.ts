import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

test('Monitor refreshes phone observations and keeps application health separate', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const checkedAt = () => new Date().toISOString();
  const counts = { source: 'available', total: 2, ready: 1, pushReachable: 0, error: 1,
    registering: 0, unregistered: 0, stale: 0, unknown: 0, lastSeenAt: checkedAt(), truncated: false };
  let phoneState: 'fresh' | 'stale' | 'unavailable' = 'fresh';
  await page.route('**/*', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="sk"><head><title>Monitor audit fixture</title></head><body><div id="root"></div></body></html>' });
    if (path === '/api/diagnostics/phones') return route.fulfill({ status: phoneState === 'unavailable' ? 503 : 200, json: {
      checkedAt: phoneState === 'stale' ? new Date(Date.now() - 180_000).toISOString() : checkedAt(),
      environment: 'test', heartbeatWindowMs: 120_000, browser: counts, mobile: { ...counts, total: 1, ready: 0, error: 0, pushReachable: 1 },
    } });
    if (path === '/api/diagnostics') return route.fulfill({ json: { checkedAt: checkedAt(), enabled: true, environment: 'test', coverage: 'limited',
      since: checkedAt(), until: checkedAt(), incidents: [], operations: [], builds: [], calls: [], storage: null, nextCursor: null } });
    if (path === '/api/health/live') return route.fulfill({ json: { status: 'live' } });
    if (path === '/api/health/ready') return route.fulfill({ json: { status: 'ready' } });
    return route.abort();
  });
  const bundle = await build({ bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    stdin: { sourcefile: 'monitor-phone-fixture.tsx', loader: 'tsx', resolveDir: process.cwd(), contents: `
      import { createRoot } from 'react-dom/client';
      import { MonitorScreen } from './src/components/monitor/MonitorScreen';
      createRoot(document.getElementById('root')).render(<MonitorScreen appVersion="diagnostic-fixture" />);
    ` },
  });
  await page.goto('https://monitor-audit.test/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const phones = page.getByRole('region', { name: 'Stav telefónov' });
  await expect(phones.getByText('Telefón hlási chybu', { exact: true })).toBeVisible();
  await expect(phones.getByText('Dosiahnuteľné cez push lease')).toBeVisible();
  await expect(page.getByText('Posledná kontrola v poriadku', { exact: true })).toHaveCount(2);

  phoneState = 'stale';
  await page.getByRole('button', { name: 'Obnoviť', exact: true }).click();
  await expect(phones.getByText('Zastarané overenie', { exact: true })).toBeVisible();
  phoneState = 'unavailable';
  await page.getByRole('button', { name: 'Obnoviť', exact: true }).click();
  await expect(phones.getByText('Obnovenie neúspešné', { exact: true })).toBeVisible();
  await expect(page.getByText('Posledná kontrola v poriadku', { exact: true })).toHaveCount(2);
  phoneState = 'fresh';
  await page.getByRole('button', { name: 'Obnoviť', exact: true }).click();
  await expect(phones.getByText('Telefón hlási chybu', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
