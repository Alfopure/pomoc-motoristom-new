import { expect, test, type Page } from "@playwright/test";
import { isolateBrowserRequests } from "./browser-isolation";

// The real server supplies the document baseline. Only subsequent browser
// release probes are mocked, so this also works with a deployed build version.
const draftPlate = "PWA DRAFT";
const initialTime = Date.UTC(2026, 8, 6, 12);

test.describe.configure({ mode: "default" });
test.setTimeout(60_000);
test.use({ viewport: { width: 390, height: 844 } });

test.beforeEach(async ({ page, baseURL }) => {
  await isolateBrowserRequests(page, baseURL!);
  await page.clock.install({ time: initialTime });
  await page.route("**/api/push/subscriptions*", (route) => route.fulfill({
    json: { configured: false, publicKey: null, subscribed: false, soundEnabled: true },
  }));
});

for (const resumeEvent of ["visibilitychange", "pageshow"] as const) {
  test(`a newer release is discovered on ${resumeEvent} and reloads only after a click`, async ({ page }, testInfo) => {
    const release = await mockReleaseProbe(page);
    const navigation = await observeReload(page);
    await openApp(page);
    await expect(updateNotice(page)).toHaveCount(0);
    release.version = release.nextVersion;
    // The resume check is deliberately throttled for 15 seconds.
    await advancePastResumeThrottle(page);
    await awaitProbe(page, () => page.evaluate((eventName) => {
      const target = eventName === "visibilitychange" ? document : window;
      target.dispatchEvent(new Event(eventName));
    }, resumeEvent));

    await expect(updateNotice(page)).toContainText("Nová verzia je pripravená.");
    await expect(updateButton(page)).toBeEnabled();
    expect(navigation.documents).toBe(1);
    expect(navigation.reloads).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    if (resumeEvent === "visibilitychange") {
      await page.screenshot({ path: testInfo.outputPath("pwa-update-390.png"), animations: "disabled" });
    }

    await updateButton(page).click();
    await expect(page.getByTestId("reloaded-app")).toBeVisible();
    expect(navigation.reloads).toBe(1);
    expect(navigation.nativeDialogs).toEqual([]);
  });
}

test("returning online discovers a release immediately without an automatic reload", async ({ page }) => {
  const release = await mockReleaseProbe(page);
  const navigation = await observeReload(page);
  await openApp(page);
  release.version = release.nextVersion;
  await awaitProbe(page, () => reconnect(page));
  await expect(updateButton(page)).toBeVisible();
  expect(navigation.documents).toBe(1);
  expect(navigation.reloads).toBe(0);
});

test("an update keeps a dirty draft after cancellation and reloads only after explicit discard", async ({ page }) => {
  const release = await mockReleaseProbe(page);
  const navigation = await observeReload(page);
  await openApp(page);
  await createDirtyDraft(page);
  release.version = release.nextVersion;
  await awaitProbe(page, () => reconnect(page));
  await expect(updateButton(page)).toBeVisible();
  await expect(page.getByLabel("EČV", { exact: true })).toHaveValue(draftPlate);
  expect(navigation.reloads).toBe(0);

  await updateButton(page).click();
  const guard = draftGuard(page);
  await expect(guard).toBeVisible();
  expect(navigation.reloads).toBe(0);
  await guard.getByRole("button", { name: "Zostať vo formulári", exact: true }).last().click();
  await expect(guard).toBeHidden();
  await expect(page.getByLabel("EČV", { exact: true })).toHaveValue(draftPlate);
  await expect(updateButton(page)).toBeVisible();
  expect(navigation.reloads).toBe(0);

  await updateButton(page).click();
  await guard.getByRole("button", { name: "Odísť bez uloženia", exact: true }).click();
  await expect(page.getByTestId("reloaded-app")).toBeVisible();
  expect(navigation.reloads).toBe(1);
  expect(navigation.nativeDialogs).toEqual([]);
});

test("manual account refresh works without an update and uses the same draft guard", async ({ page }) => {
  await mockReleaseProbe(page);
  const navigation = await observeReload(page);
  await openApp(page);
  await createDirtyDraft(page);
  await expect(updateNotice(page)).toHaveCount(0);

  await openAccountRefresh(page);
  const guard = draftGuard(page);
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Zostať vo formulári", exact: true }).last().click();
  await expect(page.getByLabel("EČV", { exact: true })).toHaveValue(draftPlate);
  expect(navigation.reloads).toBe(0);

  await openAccountRefresh(page);
  await guard.getByRole("button", { name: "Odísť bez uloženia", exact: true }).click();
  await expect(page.getByTestId("reloaded-app")).toBeVisible();
  expect(navigation.reloads).toBe(1);
  expect(navigation.nativeDialogs).toEqual([]);
});

test("offline resume has no update notice and reconnect can discover the release", async ({ page }) => {
  const release = await mockReleaseProbe(page);
  const navigation = await observeReload(page);
  await openApp(page);
  const initialChecks = release.checks;
  release.version = release.nextVersion;
  await page.context().setOffline(true);
  await advancePastResumeThrottle(page);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await settleRender(page);
  await expect(updateNotice(page)).toHaveCount(0);
  expect(release.checks).toBe(initialChecks);
  expect(navigation.reloads).toBe(0);

  await awaitProbe(page, () => page.context().setOffline(false));
  await expect(updateButton(page)).toBeVisible();
  expect(navigation.reloads).toBe(0);
});

test("canceling the app refresh leaves the ordinary browser unload guard active", async ({ page }) => {
  await mockReleaseProbe(page);
  const navigation = await observeReload(page, false);
  await openApp(page);
  await createDirtyDraft(page);
  await openAccountRefresh(page);
  await draftGuard(page).getByRole("button", { name: "Zostať vo formulári", exact: true }).last().click();

  // Simulate the browser refresh command independently of the application's
  // approved action. Canceling that native dialog must preserve the draft.
  await page.evaluate(() => { window.setTimeout(() => window.location.reload(), 0); });
  await expect.poll(() => navigation.nativeDialogs).toEqual(["beforeunload"]);
  await settleRender(page);
  await expect(page.getByLabel("EČV", { exact: true })).toHaveValue(draftPlate);
  expect(navigation.reloads).toBe(0);

  await openAccountRefresh(page);
  await draftGuard(page).getByRole("button", { name: "Odísť bez uloženia", exact: true }).click();
  await expect(page.getByTestId("reloaded-app")).toBeVisible();
  expect(navigation.reloads).toBe(1);
  expect(navigation.nativeDialogs).toEqual(["beforeunload"]);
});

test("a failed version endpoint does not invent an update and can recover on online", async ({ page }) => {
  const release = await mockReleaseProbe(page);
  const navigation = await observeReload(page);
  await openApp(page);
  release.status = 503;
  release.version = release.nextVersion;
  await awaitProbe(page, () => reconnect(page));
  await expect(updateNotice(page)).toHaveCount(0);
  expect(navigation.reloads).toBe(0);

  release.status = 200;
  await awaitProbe(page, () => page.evaluate(() => window.dispatchEvent(new Event("online"))));
  await expect(updateButton(page)).toBeVisible();
  expect(navigation.reloads).toBe(0);
});

async function mockReleaseProbe(page: Page) {
  // APIRequestContext bypasses page.route; this GET reads the actual baseline
  // before any browser probe is intercepted and never changes server data.
  const live = await page.request.get("/api/health/live");
  expect(live.ok(), "The isolated application's /api/health/live endpoint must be reachable.").toBe(true);
  const payload: { status?: unknown; version?: unknown } = await live.json();
  const baseline = typeof payload.version === "string" ? payload.version.trim() : "";
  const valid = payload.status === "live" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(baseline)
    && !["development", "dev", "local", "unknown", "undefined", "null", "unset"].includes(baseline.toLowerCase());
  expect(valid, "Start the isolated app with a release version, e.g. DEPLOYMENT_VERSION=pwa-test-a, before running PWA update tests.").toBe(true);
  const release = { version: baseline, nextVersion: baseline === "pwa-test-b" ? "pwa-test-c" : "pwa-test-b", status: 200, checks: 0 };
  await page.route("**/api/health/live", async (route) => {
    release.checks += 1;
    await route.fulfill({
      status: release.status,
      headers: { "Cache-Control": "no-store" },
      json: { status: "live", version: release.version },
    });
  });
  return release;
}

async function openApp(page: Page) {
  const probe = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/health/live");
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true", { timeout: 40_000 });
  await (await probe).finished();
  await settleRender(page);
}

async function awaitProbe(page: Page, trigger: () => Promise<unknown>) {
  const response = page.waitForResponse((candidate) => new URL(candidate.url()).pathname === "/api/health/live");
  await trigger();
  // The hook intentionally does not consume error response bodies. Waiting for
  // requestfinished there can hang even though its status was already handled.
  await response;
  await settleRender(page);
}

async function settleRender(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function advancePastResumeThrottle(page: Page) {
  await page.clock.setFixedTime(await page.evaluate(() => Date.now() + 16_000));
}

async function reconnect(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
  });
}

async function observeReload(page: Page, acceptNativeDialog = true) {
  const navigation = { documents: 0, reloads: 0, nativeDialogs: [] as string[] };
  page.on("dialog", async (dialog) => {
    navigation.nativeDialogs.push(dialog.type());
    if (acceptNativeDialog) await dialog.accept();
    else await dialog.dismiss();
  });
  await page.route((url) => url.pathname === "/", async (route) => {
    if (!route.request().isNavigationRequest() || route.request().frame() !== page.mainFrame()) {
      await route.fallback();
      return;
    }
    navigation.documents += 1;
    if (navigation.documents === 1) {
      await route.fallback();
      return;
    }
    navigation.reloads += 1;
    await route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="sk"><head><title>Reload fixture</title></head><body><p data-testid="reloaded-app">Fresh application document</p></body></html>',
    });
  });
  return navigation;
}

async function createDirtyDraft(page: Page) {
  await page.getByRole("button", { name: "Nový prípad", exact: true }).first().click();
  await page.getByLabel("EČV", { exact: true }).fill(draftPlate);
}

async function openAccountRefresh(page: Page) {
  await page.getByRole("button", { name: /^Účet / }).click();
  await page.getByRole("dialog", { name: "Používateľský účet", exact: true })
    .getByRole("button", { name: "Obnoviť aplikáciu", exact: true }).click();
}

function draftGuard(page: Page) {
  return page.getByRole("dialog", { name: "Rozpracovaný prípad nie je uložený", exact: true });
}

function updateNotice(page: Page) {
  return page.getByTestId("app-update-notice");
}

function updateButton(page: Page) {
  return updateNotice(page).getByRole("button", { name: "Obnoviť aplikáciu", exact: true });
}
