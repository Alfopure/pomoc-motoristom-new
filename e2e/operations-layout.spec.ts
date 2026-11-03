import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Operation, OperationsWorkspace } from "../src/domain/operations";

// Render production components and workspace CSS without reaching an app or provider.
test.use({ screenshot: "off", trace: "off" });
if (existsSync("/usr/bin/google-chrome")) test.use({ launchOptions: { executablePath: "/usr/bin/google-chrome" } });
const origin = "https://operations-layout.test";
let javascript = "", css = "";

test.beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { OperationsModule } from './src/components/operations/OperationsModule';
        import './src/components/dispatch/workspace-tools.css';
        createRoot(document.getElementById('root')).render(
          <div className="dispatch-app-shell">
            <header>Dispečing — skúšobné rozhranie</header>
            <main className="dispatch-standalone-workspace"><OperationsModule /></main>
            <footer>TEST — skúšobné prostredie</footer>
          </div>);`,
      resolveDir: path.resolve("."), loader: "tsx",
    },
    bundle: true, write: false, outfile: "operations-layout.js", platform: "browser", jsx: "automatic",
    define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) }, logLevel: "silent",
  });
  javascript = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith(".css"))!.text;
});

function fixture(): OperationsWorkspace {
  const operation: Operation = {
    id: "operation-1", kind: "delivery", status: "en_route", revision: 1, assignmentGeneration: 1,
    caseId: null, caseNumber: "TEST-001", fleetAssetId: "vehicle-1", vehicle: "TEST vozidlo",
    from: "Testovacie miesto vyzdvihnutia v zahraničí s dlhou adresou",
    to: "Testovacie miesto odovzdania v Bratislave s dlhou adresou",
    scheduledAt: null, plannedEndAt: null, confirmedAt: null, startedAt: "2026-10-27T07:00:00Z",
    assigneeId: "driver-1", assignee: "Testovací vodič", cycleId: null,
    owner: "logistics", ownerId: "operation-1", evidenceState: "pending", cycle: null,
    evidence: [], updatedAt: "2026-10-27T07:00:00Z",
  };
  return {
    actor: { userId: "office-1", organizationId: "test-org", displayName: "Testovací dispečer", profileId: "office-1", memberId: null, version: 1, canDispatch: true },
    operations: Array.from({ length: 8 }, (_, index) => ({ ...operation, id: `operation-${index + 1}`, ownerId: `operation-${index + 1}`, caseNumber: `TEST-${index + 1}` })),
    totalCount: 8, members: [{ id: "driver-1", name: "Testovací vodič" }], fleet: [{ id: "vehicle-1", name: "TEST vozidlo" }],
  };
}

async function mount(page: Page) {
  const unexpected: string[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin && url.pathname === "/") return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="sk"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
        *{box-sizing:border-box}body{margin:0;font:13px/1.45 system-ui}h1,h2,h3,p{margin:0}button,input,select,textarea{font:inherit}
        .dispatch-app-shell{display:flex;flex-direction:column;height:100dvh;overflow:hidden}
        .dispatch-app-shell>header,.dispatch-app-shell>footer{flex:none;padding:12px;background:#18181b;color:white}
        ${css}</style></head><body><div id="root"></div><script>${javascript}</script></body></html>`,
    });
    if (url.origin === origin && url.pathname === "/api/operations" && request.method() === "GET") return route.fulfill({ json: fixture() });
    unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
    return route.abort();
  });
  await page.goto(origin);
  await expect(page.getByRole("button").filter({ hasText: "TEST-1" })).toHaveCount(1);
  return { unexpected, errors };
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".dispatch-standalone-workspace")!;
    return document.documentElement.scrollWidth <= innerWidth && main.scrollWidth <= main.clientWidth;
  })).toBe(true);
}

test("unselected list fills the workspace and closing the detail restores its width", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const trace = await mount(page);
  const row = page.getByRole("button").filter({ hasText: "TEST-1" });
  const fullWidth = (await row.boundingBox())!.width;
  const mainWidth = (await page.locator("main").boundingBox())!.width;
  expect(fullWidth).toBeGreaterThan(mainWidth * 0.9);
  await row.click();
  const detail = page.getByRole("complementary", { name: "Detail jazdy" });
  await expect(detail).toBeVisible();
  expect((await detail.boundingBox())!.width).toBeGreaterThan((await row.boundingBox())!.width);
  await page.getByRole("button", { name: "Zavrieť detail jazdy" }).click();
  await expect(detail).toHaveCount(0);
  expect((await row.boundingBox())!.width).toBeCloseTo(fullWidth, 0);
  await expectNoHorizontalOverflow(page);
  expect(trace).toEqual({ unexpected: [], errors: [] });
});

for (const width of [360, 768, 1050, 1440]) {
  test(`long detail remains scrollable and fits the workspace at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const trace = await mount(page);
    const row = page.getByRole("button").filter({ hasText: "TEST-1" });
    await row.click();
    const detail = page.getByRole("complementary", { name: "Detail jazdy" });
    await expect(detail).toBeVisible();
    if (width <= 1050) expect((await detail.boundingBox())!.y).toBeLessThan((await row.boundingBox())!.y);
    await detail.getByRole("button", { name: "Doplniť", exact: true }).click();
    const main = page.locator("main");
    await main.evaluate(element => { element.scrollTop = 0; });
    await main.hover({ position: { x: 30, y: 100 } });
    await page.mouse.wheel(0, 1200);
    await expect.poll(() => main.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    const save = detail.getByRole("button", { name: "Uložiť dôkaz", exact: true });
    await save.scrollIntoViewIfNeeded();
    const bounds = (await main.boundingBox())!, button = (await save.boundingBox())!;
    expect(button.y).toBeGreaterThanOrEqual(bounds.y);
    expect(button.y + button.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
    await expectNoHorizontalOverflow(page);
    expect(trace).toEqual({ unexpected: [], errors: [] });
  });
}
