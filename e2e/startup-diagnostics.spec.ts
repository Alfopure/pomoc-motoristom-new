import { build } from "esbuild";
import { expect, test, type Page } from "@playwright/test";

let script: string;
test.beforeAll(async () => {
  const bundle = await build({ bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import './src/instrumentation-client';
      import { createRoot } from 'react-dom/client';
      import { StartupDiagnostics } from './src/components/diagnostics/StartupDiagnostics';
      import { startupDiagnostics } from './src/lib/diagnostics/startup';
      import { recordDiagnostic } from './src/lib/diagnostics/client';
      window.startupFixture = {
        hydrate() { createRoot(document.getElementById('root')).render(<StartupDiagnostics />); },
        authenticate() { window.startupAuthorized = true; startupDiagnostics.publish(recordDiagnostic); }
      };
    ` },
    plugins: [{ name: "isolated-startup-sinks", setup(builder) {
      builder.onResolve({ filter: /diagnostics\/(client|errors|sentry)$/ }, args => ({ path: args.path.split("/").at(-1)!, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ loader: "js", contents:
        args.path === "client" ? `export function recordDiagnostic(event){ if(!window.startupAuthorized)return null; window.startupRecords.push(event); return 'accepted'; } export async function flushDiagnostics(){}` :
        args.path === "errors" ? `export function captureDiagnosticError(error){window.startupErrors.push(error.name);}` :
        `export async function flushDiagnosticExceptions(){}` }));
    } }],
  });
  script = bundle.outputFiles[0].text;
});

async function mount(page: Page) {
  await page.clock.install();
  await page.route("**/*", route => route.request().resourceType() === "document"
    ? route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div>' }) : route.abort());
  await page.addInitScript({ content: `window.startupRecords=[];window.startupErrors=[];window.startupAuthorized=false;${script}` });
  await page.goto("https://startup.test/");
}

test("first React commit is measured before login without creating a false startup timeout", async ({ page }) => {
  await mount(page);
  await page.evaluate(() => window.startupFixture.hydrate());
  await page.clock.runFor(100);
  expect(await page.evaluate(() => window.startupRecords)).toEqual([]);
  await page.evaluate(() => window.startupFixture.authenticate());
  await expect.poll(() => page.evaluate(() => window.startupRecords.map(event => event.reason))).toEqual(["startup_started", "startup_ready"]);
  await page.clock.runFor(31_000);
  expect(await page.evaluate(() => window.startupErrors)).toEqual([]);
});

test("a page whose React bundle never mounts reports timeout and preserves later recovery", async ({ page }) => {
  await mount(page);
  await page.clock.runFor(30_001);
  expect(await page.evaluate(() => window.startupErrors)).toEqual(["TimeoutError"]);
  await page.evaluate(() => { window.startupFixture.authenticate(); window.startupFixture.hydrate(); });
  await page.clock.runFor(100);
  await expect.poll(() => page.evaluate(() => window.startupRecords.map(event => event.reason))).toEqual(["startup_started", "startup_timeout", "startup_ready"]);
});

test("a suspended hidden startup gets a fresh foreground budget and is still checked on return", async ({ page }) => {
  await mount(page);
  await page.evaluate(() => Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }));
  await page.clock.runFor(60_000);
  expect(await page.evaluate(() => window.startupErrors)).toEqual([]);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(29_000);
  expect(await page.evaluate(() => window.startupErrors)).toEqual([]);
  await page.clock.runFor(1_001);
  expect(await page.evaluate(() => window.startupErrors)).toEqual(["TimeoutError"]);
});

declare global {
  interface Window {
    startupAuthorized: boolean;
    startupRecords: Array<{ reason: string }>;
    startupErrors: string[];
    startupFixture: { hydrate(): void; authenticate(): void };
  }
}
