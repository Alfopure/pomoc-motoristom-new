import { build } from 'esbuild';
import { expect, test, type Page } from '@playwright/test';
import type { SafeException } from '../src/lib/diagnostics/sentry';

declare global {
    interface Window {
        diagnosticFixture: { flush(): Promise<void>; capture(error: unknown): string | null };
        diagnosticRecords: Array<{ type: string; errorClass?: string; errorId?: string }>;
    }
}
let script: string;
test.beforeAll(async () => {
    const bundle = await build({
        stdin: { contents: `import './src/instrumentation-client'; import { flushDiagnosticExceptions } from './src/lib/diagnostics/sentry'; import { captureDiagnosticError } from './src/lib/diagnostics/errors'; window.diagnosticFixture={flush:flushDiagnosticExceptions,capture:captureDiagnosticError};`, resolveDir: process.cwd() },
        bundle: true, write: false, platform: 'browser', format: 'iife',
        define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_DIAGNOSTICS_SENTRY_DSN': '"https://public@errors.test/1"', 'process.env.NEXT_PUBLIC_DIAGNOSTICS_BUILD_ID': '"diagnostics-fixture"', 'process.env.NEXT_PUBLIC_DIAGNOSTICS_ENVIRONMENT': '"test"' },
        plugins: [{ name: 'isolated-internal-collector', setup(builder) {
            builder.onResolve({ filter: /\/client$/ }, args => {
                if (args.importer.endsWith('/instrumentation-client.ts') || args.importer.endsWith('/diagnostics/errors.ts')) return { path: 'collector', namespace: 'fixture' };
            });
            builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `export function recordDiagnostic(event){window.diagnosticRecords.push(event);return null;} export function getDiagnosticPageId(){return '11111111-1111-4111-8111-111111111111';} export async function flushDiagnostics(){}` }));
        } }],
    });
    script = bundle.outputFiles[0].text;
});

async function setup(page: Page, status = 200) {
    const envelopes: SafeException[] = [];
    await page.route('**/*', route => {
        if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Diagnostic capture regression</title>' });
        if (new URL(route.request().url()).origin === 'https://errors.test') {
            const lines = route.request().postData()!.split('\n');
            envelopes.push(JSON.parse(lines[2]));
            return route.fulfill({ status, headers: { 'access-control-allow-origin': '*' }, body: '{}' });
        }
        if (/^\/_next\/static\/(?:immutable\/)?chunks\/abcdef1234567890\.js$/.test(new URL(route.request().url()).pathname)) return route.fulfill({ contentType: 'application/javascript', body: "throw new TypeError('CANARY_email@example.com +421901123456 CANARY_SECRET');" });
        return route.abort();
    });
    await page.addInitScript({ content: `window.diagnosticRecords=[];\n${script}` });
    await page.goto('https://diagnostics.test/');
    return envelopes;
}
async function raise(page: Page, options: { crossRealm?: boolean; missing?: boolean; foreign?: boolean; column?: number } = {}) {
    return page.evaluate(options => {
        let error: Error | null = new TypeError('CANARY_email@example.com +421901123456 CANARY_SECRET');
        if (options.crossRealm) {
            const iframe = document.createElement('iframe'); document.body.append(iframe);
            error = new (iframe.contentWindow as Window & typeof globalThis).TypeError('CANARY_SECRET');
        }
        if (options.missing) error = null;
        const filename = `${options.foreign ? 'https://foreign.test' : location.origin}/_next/static/chunks/abcdef1234567890.js?CANARY_SECRET`;
        if (error) error.stack = `CANARY_FUNCTION@${filename}:12:${options.column ?? 34}`;
        window.dispatchEvent(new ErrorEvent('error', { error, message: 'CANARY_SECRET', filename, lineno: 12, colno: options.column ?? 34 }));
        return window.diagnosticRecords.findLast(event => event.type === 'ui_error')?.errorId;
    }, options);
}

test('ErrorEvent without an Error retains owned coordinates and omits private data', async ({ page }) => {
    const envelopes = await setup(page); const id = await raise(page, { missing: true });
    await expect.poll(() => envelopes.length).toBe(1);
    expect(envelopes[0]).toMatchObject({ event_id: id, release: 'diagnostics-fixture', environment: 'test', exception: { values: [{ type: 'UnknownError', stacktrace: { frames: [{ filename: 'https://diagnostics.test/_next/static/chunks/abcdef1234567890.js', lineno: 12, colno: 34 }] } }] } });
    expect(JSON.stringify(envelopes)).not.toMatch(/CANARY|example.com|421901|FUNCTION/);
});
test('cross-realm TypeError retains its class and stack', async ({ page }) => {
    const envelopes = await setup(page); await raise(page, { crossRealm: true });
    await expect.poll(() => envelopes.length).toBe(1);
    expect(envelopes[0].exception.values[0]).toMatchObject({ type: 'TypeError', stacktrace: { frames: [{ lineno: 12, colno: 34 }] } });
    expect(JSON.stringify(envelopes)).not.toContain('CANARY');
});
for (const directory of ['chunks', 'immutable/chunks']) test(`a real browser throw preserves native lazy stack coordinates under ${directory}`, async ({ page }) => {
    const envelopes = await setup(page);
    const filename = `https://diagnostics.test/_next/static/${directory}/abcdef1234567890.js`;
    await page.addScriptTag({ url: filename });
    await expect.poll(() => envelopes.length).toBe(1);
    expect(envelopes[0].exception.values[0]).toMatchObject({ type: 'TypeError', stacktrace: { frames: [{ filename, lineno: 1 }] } });
    expect(JSON.stringify(envelopes)).not.toContain('CANARY');
});
test('offline error survives reload and is delivered once after online with its original ID and time', async ({ page, context }) => {
    const envelopes = await setup(page); await context.setOffline(true);
    const id = await raise(page);
    const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('dispatch-exceptions-v1')!).entries[0].event);
    expect(saved.event_id).toBe(id); expect(JSON.stringify(saved)).not.toContain('CANARY'); expect(envelopes).toHaveLength(0);
    await page.reload(); expect(envelopes).toHaveLength(0);
    await context.setOffline(false);
    await expect.poll(() => envelopes.length).toBe(1);
    expect(envelopes[0]).toMatchObject({ event_id: id, timestamp: saved.timestamp, release: saved.release });
    await page.reload(); await page.evaluate(() => window.diagnosticFixture.flush());
    expect(envelopes).toHaveLength(1);
});
test('offline error storm stays bounded and reload cannot reset the send budget', async ({ page, context }) => {
    const envelopes = await setup(page); await context.setOffline(true);
    await page.evaluate(() => {
        for (let column = 1; column <= 1000; column++) {
            window.dispatchEvent(new ErrorEvent('error', { filename: `${location.origin}/_next/static/chunks/abcdef1234567890.js`, lineno: 12, colno: column, message: 'CANARY' }));
        }
    });
    const stored = await page.evaluate(() => sessionStorage.getItem('dispatch-exceptions-v1')!);
    expect(JSON.parse(stored).entries).toHaveLength(8); expect(new TextEncoder().encode(stored).byteLength).toBeLessThanOrEqual(32 * 1024); expect(stored).not.toContain('CANARY');
    await context.setOffline(false); await expect.poll(() => envelopes.length).toBe(2);
    await page.reload(); await page.evaluate(() => window.diagnosticFixture.flush()); expect(envelopes).toHaveLength(2);
});
test('foreign coordinates stay opaque instead of producing an invalid empty stack', async ({ page }) => {
    const envelopes = await setup(page); await raise(page, { missing: true, foreign: true });
    await expect.poll(() => envelopes.length).toBe(1);
    expect(envelopes[0].exception.values[0]).toEqual({ type: 'UnknownError', value: 'UnknownError' });
    expect(JSON.stringify(envelopes)).not.toMatch(/CANARY|foreign/);
});
