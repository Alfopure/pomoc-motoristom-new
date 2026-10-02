import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] } });
let script: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ['e2e/fixtures/case-editor-feedback.tsx'], outfile: 'feedback.js', bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { '@/lib/supabase/browser': path.resolve('e2e/fixtures/case-collaboration-realtime.ts') }, define: { 'process.env': JSON.stringify({ NODE_ENV: 'production' }) } });
  script = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
});
test('editor state changes do not loop when a parent records status and replaces callbacks', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url() === 'https://editor-feedback.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
    : route.fulfill({ status: 503, json: { error: 'Isolated fixture' } }));
  await page.goto('https://editor-feedback.test');
  await page.addScriptTag({ content: script });
  await expect(page.getByTestId('case-edit-form-main')).toBeVisible();
  await page.getByRole('button', { name: 'Obnoviť nadradený panel' }).click();
  const before = await page.evaluate(() => (window as unknown as { editorFeedback: { dirty: boolean[]; saving: boolean[] } }).editorFeedback);
  expect(before).toEqual({ dirty: [false], saving: [false] });
  await page.getByText('2. Zákazník a kontakty', { exact: true }).click();
  const name = page.getByLabel('Meno', { exact: true }).first();
  await name.fill('Synthetic draft');
  await expect.poll(() => page.evaluate(() => (window as unknown as { editorFeedback: { dirty: boolean[] } }).editorFeedback.dirty)).toEqual([false, true]);
  await page.getByRole('button', { name: 'Obnoviť nadradený panel' }).click();
  await expect(name).toHaveValue('Synthetic draft');
  expect(errors).toEqual([]);
});
