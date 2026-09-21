import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";

const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
const baselineCommit = "604e62b29e191283c5ee46cbabd8b94435c57162";
const bundles = new Map<string, { script: string; css: string }>();
test.use({ launchOptions: { ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}), args: ["--no-sandbox"] } });
test.beforeAll(async () => {
  const baseCss = (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
  for (const variant of ["current", "baseline"]) {
    const result = await build({ entryPoints: ["e2e/fixtures/case-sync-phone-isolation.tsx"], bundle: true, write: false, outfile: `sync-phone-${variant}.js`, platform: "browser", format: "iife", jsx: "automatic",
      alias: { "@telnyx/webrtc": path.resolve("e2e/fixtures/mobile-calling-sdk.ts"), "@/lib/telephony/realtime-client": path.resolve("e2e/fixtures/mobile-calling-realtime.ts"), "@/lib/supabase/browser": path.resolve("e2e/fixtures/case-collaboration-realtime.ts") },
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: variant !== "baseline" ? [] : [{ name: "exact-pre-change-case-boundary", setup(plugin) {
        plugin.onResolve({ filter: /\/CaseSyncIndicator$/ }, () => ({ path: "no-sync-icon", namespace: "baseline" }));
        plugin.onLoad({ filter: /.*/, namespace: "baseline" }, () => ({ contents: "export function CaseSyncIndicator() { return null; }", loader: "tsx" }));
        plugin.onLoad({ filter: /\/(CaseCollaborationProvider\.tsx|case-collaboration-store\.ts)$/ }, args => {
          const relative = path.relative(process.cwd(), args.path);
          let contents = execFileSync("git", ["show", `${baselineCommit}:${relative}`], { encoding: "utf8" });
          // Read-only test instrumentation; the original provider/store runtime is otherwise unchanged.
          if (relative.endsWith("CaseCollaborationProvider.tsx")) contents += "\nexport function useCaseCollaborationStore() { return useContext(Context)?.store ?? null; }\n";
          return { contents, loader: relative.endsWith("tsx") ? "tsx" : "ts", resolveDir: path.dirname(args.path) };
        });
      } }],
    });
    bundles.set(variant, { script: result.outputFiles.find(file => file.path.endsWith(".js"))!.text, css: baseCss + result.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n") });
  }
});

async function boot(page: Page, variant = "current") {
  const failures: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  await page.route("**/*", route => {
    if (route.request().url() === "https://sync-phone.test/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"><div id="root"></div></body></html>' });
    if (route.request().url() === "https://sync-phone.test/workplace-heartbeat-worker.js") return route.fulfill({ contentType: "text/javascript", body: "" });
    failures.push(`Unexpected network ${route.request().url()}`); return route.abort();
  });
  await page.goto("https://sync-phone.test/");
  const bundle = bundles.get(variant)!;
  await page.addStyleTag({ content: bundle.css }); await page.addScriptTag({ content: bundle.script });
  await expect(page.locator("#phone-state")).toHaveAttribute("data-status", "registered");
  await expect(page.locator("#case-state")).toContainText("Saved revision 1");
  return failures;
}
const counters = (page: Page) => page.evaluate(() => {
  const h = window.syncPhoneHarness;
  return { created: h.sdkCreated, connected: h.sdkConnected, login: h.sdkLogin, disconnected: h.sdkDisconnected,
    answers: h.sdkAnswers, hangups: h.sdkHangups, microphones: h.microphoneRequests, stopped: h.stoppedTracks, mounts: h.mounts, cleanups: h.cleanups };
});
async function flushBrowserTasks(page: Page) {
  // Fetch response streams and React commit tasks use real browser task queues, not fake timers.
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) await new Promise<void>(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
      channel.port2.postMessage(null);
    });
  });
}

test("case reads and the popup keep the real phone hook, invite, media and dirty input intact", async ({ page }) => {
  await page.clock.install(); const failures = await boot(page); await page.clock.runFor(600);
  await page.evaluate(() => window.syncPhoneHarness.callState("ringing"));
  await expect(page.getByRole("button", { name: "Prijať", exact: true })).toBeEnabled();
  const note = page.getByLabel("Rozpracovaná poznámka"); await note.fill("Môj text");
  await note.evaluate(node => { (node as HTMLInputElement).setSelectionRange(2, 2); Object.assign(node, { originalNode: true }); });
  await page.getByTestId("phone-bar").evaluate(node => Object.assign(node, { originalPhoneBar: true }));
  const before = await counters(page);
  const ledgerStart = await page.evaluate(() => window.syncPhoneHarness.ledger.length);
  await page.evaluate(() => { window.syncPhoneHarness.revision = 2; window.syncPhoneHarness.caseDelay = 300; window.syncPhoneHarness.refreshCases(); });
  const indicator = page.getByRole("button", { name: /^Stav aktualizácií:/ });
  await expect(indicator).toHaveAttribute("data-state", "updating");
  await indicator.click(); await expect(page.getByRole("dialog")).toBeVisible();
  const popup = await page.getByRole("dialog").boundingBox(), bars = await page.getByTestId("fixture-top-bars").boundingBox();
  expect(popup!.y).toBeGreaterThanOrEqual(bars!.y + bars!.height);
  await page.clock.runFor(350); await expect(page.locator("#case-state")).toContainText("Saved revision 2");
  await expect(indicator).toHaveAttribute("data-state", "current");
  expect(await counters(page)).toEqual(before);
  expect(await page.evaluate(start => window.syncPhoneHarness.ledger.slice(start).filter(row => row.url.startsWith("/api/telephony/")), ledgerStart)).toEqual([]);
  expect(await page.getByTestId("phone-bar").evaluate(node => Boolean((node as HTMLElement & { originalPhoneBar?: boolean }).originalPhoneBar))).toBe(true);
  expect(await note.evaluate(node => [(node as HTMLInputElement).selectionStart, Boolean((node as HTMLInputElement & { originalNode?: boolean }).originalNode)])).toEqual([2, true]);
  await expect(note).toHaveValue("Môj text"); await expect(page.locator("#phone-state")).toHaveAttribute("data-call", "fixture-incoming");
  // Outside close must not swallow this exact browser invite's user gesture.
  await page.getByRole("button", { name: "Prijať", exact: true }).click();
  expect(await page.evaluate(() => [window.syncPhoneHarness.sdkAnswers, window.syncPhoneHarness.microphoneRequests])).toEqual([1, 1]);
  expect(await page.evaluate(() => window.syncPhoneHarness.answeredIds)).toEqual(["fixture-incoming"]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => window.syncPhoneHarness.unexpected)).toEqual([]); expect(failures).toEqual([]);
});

test("the same virtual time preserves phone request cadence with and without case refresh", async ({ page, browser }) => {
  // Different browser contexts preserve each phone's real Web Lock owner and clock.
  const controlContext = await browser.newContext(); const control = await controlContext.newPage(); const pages = [control, page];
  const failures: string[][] = [];
  for (const current of pages) {
    await current.clock.install({ time: new Date("2026-09-21T13:00:00Z") }); failures.push(await boot(current));
    await current.clock.pauseAt(new Date("2026-09-21T13:00:01Z"));
    await flushBrowserTasks(current);
  }
  const starts = await Promise.all(pages.map(current => current.evaluate(() => window.syncPhoneHarness.ledger.length)));
  await page.evaluate(() => window.syncPhoneHarness.refreshCases());
  for (const current of pages) {
    for (let second = 0; second < 60; second++) { await current.clock.runFor(1_000); await flushBrowserTasks(current); }
    await expect(current.locator("#phone-state")).toHaveAttribute("data-stale", "false");
  }
  const requests = await Promise.all(pages.map((current, index) => current.evaluate(start => window.syncPhoneHarness.ledger.slice(start).filter(row => row.url.startsWith("/api/telephony/")).map(row => `${row.method} ${row.url}`), starts[index])));
  expect(requests[1]).toEqual(requests[0]); expect(requests[0].length).toBeGreaterThan(0);
  expect(await counters(page)).toEqual(await counters(control));
  for (const current of pages) expect(await current.evaluate(() => window.syncPhoneHarness.unexpected)).toEqual([]);
  expect(failures.flat()).toEqual([]);
  await controlContext.close();
});

test("failure and growing phone bars never obstruct hangup on a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 }); const failures = await boot(page);
  await page.evaluate(() => window.syncPhoneHarness.callState("active"));
  await expect(page.locator("#phone-state")).toHaveAttribute("data-call", "fixture-incoming");
  await page.evaluate(() => { window.syncPhoneHarness.caseFailure = true; window.syncPhoneHarness.refreshCases(); });
  const indicator = page.getByRole("button", { name: /^Stav aktualizácií:/ });
  await expect(indicator).toHaveAttribute("data-state", "error");
  await indicator.click(); await expect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate(() => window.syncPhoneHarness.setBarsHeight(650));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => window.syncPhoneHarness.setBarsHeight(0));
  await indicator.click(); await expect(page.getByRole("dialog")).toBeVisible();
  const hangup = page.getByRole("button", { name: "Zavesiť", exact: true });
  await hangup.click();
  expect(await page.evaluate(() => window.syncPhoneHarness.sdkHangups)).toBe(1);
  expect(await page.evaluate(() => window.syncPhoneHarness.hungUpIds)).toEqual(["fixture-incoming"]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => window.syncPhoneHarness.unexpected)).toEqual([]); expect(failures).toEqual([]);
});

test("30 click-to-SDK samples compare the exact dev baseline with the sync change", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const results: Record<string, number[]> = {};
  for (const variant of ["baseline", "current"]) {
    const baselineContext = variant === "baseline" ? await browser.newContext() : null;
    const current = baselineContext ? await baselineContext.newPage() : page;
    const failures = await boot(current, variant);
    for (let index = 0; index < 30; index++) {
      await current.evaluate(number => { const h = window.syncPhoneHarness; h.caseDelay = 80; h.revision++; h.refreshCases(); h.callState("ringing", `perf-${number}`); }, index);
      const answer = current.getByRole("button", { name: "Prijať", exact: true }); await expect(answer).toBeEnabled();
      await answer.click();
      await expect.poll(() => current.evaluate(() => window.syncPhoneHarness.sdkAnswers)).toBe(index + 1);
      await current.evaluate(number => window.syncPhoneHarness.callState("hangup", `perf-${number}`), index);
      await expect(current.locator("#phone-state")).toHaveAttribute("data-call", "");
    }
    results[variant] = await current.evaluate(() => window.syncPhoneHarness.samples);
    expect(results[variant]).toHaveLength(30); expect(failures).toEqual([]);
    expect(await current.evaluate(() => window.syncPhoneHarness.unexpected)).toEqual([]);
    await baselineContext?.close();
  }
  const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
  const baselineP95 = p95(results.baseline), currentP95 = p95(results.current), allowedIncrease = Math.max(20, baselineP95 * .1);
  await mkdir(".context", { recursive: true });
  await writeFile(".context/case-sync-phone-performance.json", JSON.stringify({ baselineCommit, headCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), workingTree: execFileSync("git", ["status", "--porcelain", "--", "src", "e2e"], { encoding: "utf8" }).trim() ? "modified" : "clean", browser: await page.context().browser()?.version(),
    measurement: "DOM click capture to original fake SDK answer callback, real useTelephonyConsole/PhoneBar, production React, same isolated fixture and delayed case reads; provider network/audio latency not measured", samplesMs: results, baselineP95, currentP95, allowedIncrease }, null, 2));
  expect(currentP95 - baselineP95).toBeLessThanOrEqual(allowedIncrease);
});
