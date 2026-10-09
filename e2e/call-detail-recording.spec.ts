import { expect, test, type Page, type Route } from "@playwright/test";
import { build } from "esbuild";
import type { CallRecordingDetail } from "../src/lib/telephony/recording-quality";

const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
let script: string;
let css: string;

test.beforeAll(async () => {
  const result = await build({ entryPoints: ["e2e/fixtures/call-detail-recording.tsx"], bundle: true, write: false,
    outdir: "e2e/.call-detail-recording-build", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' } });
  script = result.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  css = result.outputFiles.find((file) => file.path.endsWith(".css"))!.text;
});

function detail(index: number): CallRecordingDetail {
  return {
    callId: id(index), sourceRevision: 1, access: "full", state: "partial", stateReason: `Záznam testovacieho hovoru ${index}`,
    liveState: "stopped", suppressed: false,
    segments: [{ id: id(index + 200), index: 0, startSeconds: 16, durationSeconds: 43, state: "partial", channels: 1, canPlay: true, error: null }],
    gaps: [], transcript: { status: "disabled", language: null, spans: [] }, analysis: null, analysisState: "disabled", metrics: null,
    capabilities: { canReview: false, canAppeal: false, canCorrect: false, canDelete: true, canControl: false, canRetry: false },
  };
}

async function setup(page: Page) {
  const state = { reads: [] as number[], pending: new Map<number, Route>(), delay: new Set<number>(), deny: false };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      *{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:#18181b;font:14px/1.5 Arial,sans-serif}main{max-width:900px;margin:20px auto;padding:20px}button{font:inherit;padding:8px;border:1px solid #ddd;border-radius:6px;background:white;cursor:pointer}button:disabled{opacity:.6}h1,h2,h3,p{margin:10px 0}svg{width:16px;height:16px;vertical-align:middle}section{padding:14px;border:1px solid #ddd;border-radius:8px;margin:12px 0}[role=dialog]{background:white;padding:20px}[role=dialog][aria-hidden=true]{display:none}[data-testid=call-recording-detail]{margin-top:16px}audio{width:100%}
      </style><div id="root"></div></html>` });
    const match = url.pathname.match(/\/calls\/[^/]+\/(recording-detail|journey)$/);
    if (match) {
      const index = Number(url.pathname.split("/")[4].slice(-12));
      if (match[1] === "journey") return route.fulfill({ json: { ok: true, journey: null } });
      state.reads.push(index);
      if (state.delay.has(index)) { state.pending.set(index, route); return; }
      return state.deny ? route.fulfill({ status: 403, json: { code: "forbidden" } }) : route.fulfill({ json: detail(index) });
    }
    errors.push(`Unexpected request: ${url.pathname}`);
    return route.abort();
  });
  await page.goto("https://call-detail.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("button", { name: "Hovor 1", exact: true })).toBeVisible();
  return { state, errors };
}

for (const diagnostics of [true, false]) {
  test(`changing call selection keeps exactly one recording panel (diagnostics ${diagnostics ? "enabled" : "hidden"})`, async ({ page }) => {
    const { state, errors } = await setup(page);
    await page.evaluate((enabled) => window.callDetailFixture.diagnostics(enabled), diagnostics);
    for (const index of [1, 2, 3, 1, 3, 2]) {
      await page.evaluate((selected) => window.callDetailFixture.select(selected), index);
      await expect(page.getByText(`Záznam testovacieho hovoru ${index}`, { exact: true })).toBeVisible();
      await expect(page.getByTestId("call-recording-detail")).toHaveCount(1);
      await expect(page.getByRole("heading", { name: "Záznam a kvalita hovoru", exact: true })).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Odstrániť záznam", exact: true })).toHaveCount(1);
      for (const other of [1, 2, 3].filter((value) => value !== index)) {
        await expect(page.getByText(`Záznam testovacieho hovoru ${other}`, { exact: true })).toHaveCount(0);
      }
    }
    expect(state.reads).toEqual([1, 2, 3, 1, 3, 2]);
    await page.getByRole("button", { name: "Zavrieť detail hovoru", exact: true }).click();
    await expect(page.getByTestId("call-recording-detail")).toHaveCount(0);
    await page.getByRole("button", { name: "Hovor 1", exact: true }).click();
    await expect(page.getByText("Záznam testovacieho hovoru 1", { exact: true })).toBeVisible();
    await expect(page.getByTestId("call-recording-detail")).toHaveCount(1);
    expect(state.reads).toEqual([1, 2, 3, 1, 3, 2, 1]);
    if (diagnostics) await page.screenshot({ path: ".context/call-detail-recording-single-panel.png", fullPage: true });
    expect(errors).toEqual([]);
  });
}

test("a slow previous detail cannot survive a call change or a denied refresh", async ({ page }) => {
  const { state, errors } = await setup(page);
  state.delay.add(1);
  await page.getByRole("button", { name: "Hovor 1", exact: true }).click();
  await expect.poll(() => state.pending.has(1)).toBe(true);
  await expect(page.getByText("Načítavam záznam hovoru…", { exact: true })).toBeVisible();
  await page.evaluate(() => window.callDetailFixture.select(2));
  await expect(page.getByText("Záznam testovacieho hovoru 2", { exact: true })).toBeVisible();
  await state.pending.get(1)!.fulfill({ json: detail(1) });
  await page.evaluate(() => {});
  await expect(page.getByTestId("call-recording-detail")).toHaveCount(1);
  await expect(page.getByText("Načítavam záznam hovoru…", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Záznam testovacieho hovoru 1", { exact: true })).toHaveCount(0);
  state.deny = true;
  await page.getByTestId("call-recording-detail").getByRole("button", { name: "Obnoviť", exact: true }).click();
  await expect(page.getByText("Na tento záznam nemáte oprávnenie.", { exact: true })).toBeVisible();
  await expect(page.getByText("Záznam testovacieho hovoru 2", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Úsek 1/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});
