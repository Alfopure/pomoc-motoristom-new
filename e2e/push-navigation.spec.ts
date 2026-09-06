import { expect, test, type Page } from "@playwright/test";
import { isolateBrowserRequests } from "./browser-isolation";

const taskId = "task-0517-callback";
const draftPlate = "PUSH DRAFT";
const unavailableNotice = "Úloha už nie je dostupná. Skontroluj zoznam úloh.";

test.describe.configure({ mode: "serial" });
test.setTimeout(60_000);
test.use({ viewport: { width: 390, height: 900 } });

test.beforeEach(async ({ page, baseURL }) => {
  await isolateBrowserRequests(page, baseURL!);
  await page.route("**/api/push/subscriptions*", (route) => route.fulfill({
    json: { configured: false, publicKey: null, subscribed: false, soundEnabled: true },
  }));
  // Opening a task acknowledges its notification; keep that real write local.
  await page.route(/\/api\/notifications(?:\/|$|\?)/, (route) => route.fulfill({ json: { notifications: [] } }));
});

test("cold push link opens the matching task and consumes its query", async ({ page }) => {
  await openApp(page, `/?task=${taskId}`);
  await expectOpenTask(page);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-mobile-pane", "workspace");
  await expect(page.getByRole("navigation", { name: "Mobilná navigácia" }).locator('[aria-current="page"]')).toHaveAccessibleName("Úlohy");
});

test("unknown cold push link shows a safe task list without a reload loop", async ({ page }) => {
  let documents = 0;
  page.on("request", (request) => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents += 1; });
  await openApp(page, "/?task=task-not-visible-to-this-user");
  await expect(page.getByRole("heading", { name: "Zoznam úloh", exact: true })).toBeVisible();
  await expect(page.getByText(unavailableNotice, { exact: true })).toBeVisible();
  // A subsequent state update must not keep trying to open the missing task.
  await page.getByRole("button", { name: "Nová úloha", exact: true }).click();
  await expect(page.locator("#new-task-form")).toBeVisible();
  await expect(page.getByText(unavailableNotice, { exact: true })).toBeVisible();
  expect(documents).toBe(1);
});

test("warm push link protects an unfinished draft and cancellation preserves its values", async ({ page }) => {
  await openApp(page);
  await createDirtyDraft(page);
  await sendPushOpen(page, `/?task=${taskId}`);
  const guard = page.getByRole("dialog", { name: "Rozpracovaný prípad nie je uložený", exact: true });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Zostať vo formulári", exact: true }).last().click();
  await expect(guard).toBeHidden();
  await expect(page.getByLabel("EČV", { exact: true })).toHaveValue(draftPlate);
  await expect(page.locator(`#task-${taskId}`)).toHaveCount(0);

  await sendPushOpen(page, `/?task=${taskId}`);
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Odísť bez uloženia", exact: true }).click();
  await expectOpenTask(page);
});

test("a new task absent from an old tab reloads only after the draft guard approves", async ({ page }) => {
  const newTaskId = "new-task-not-yet-in-this-tab";
  let taskNavigations = 0;
  await openApp(page);
  await createDirtyDraft(page);
  await page.route(`**/?task=${newTaskId}`, async (route) => {
    if (!route.request().isNavigationRequest()) { await route.fallback(); return; }
    taskNavigations += 1;
    await route.fulfill({ contentType: "text/html", body: '<!doctype html><title>Push reload fixture</title><p data-testid="fresh-task-page">Fresh authenticated page would load here.</p>' });
  });
  const guard = page.getByRole("dialog", { name: "Rozpracovaný prípad nie je uložený", exact: true });
  await sendPushOpen(page, `/?task=${newTaskId}`);
  await expect(guard).toBeVisible();
  expect(taskNavigations).toBe(0);
  await guard.getByRole("button", { name: "Zostať vo formulári", exact: true }).last().click();
  await expect(page.getByLabel("EČV", { exact: true })).toHaveValue(draftPlate);
  expect(taskNavigations).toBe(0);

  await sendPushOpen(page, `/?task=${newTaskId}`);
  await guard.getByRole("button", { name: "Odísť bez uloženia", exact: true }).click();
  await expect(page.getByTestId("fresh-task-page")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`\\?task=${newTaskId}$`));
  expect(taskNavigations).toBe(1);
});

test("a forged external push link cannot navigate or discard a draft", async ({ page }) => {
  await openApp(page);
  await createDirtyDraft(page);
  const originalUrl = page.url();
  await sendPushOpen(page, "https://untrusted.example/?task=task-0517-callback");
  await expect(page.getByLabel("EČV", { exact: true })).toHaveValue(draftPlate);
  await expect(page.getByRole("dialog", { name: "Rozpracovaný prípad nie je uložený", exact: true })).toBeHidden();
  await expect(page).toHaveURL(originalUrl);
});

async function openApp(page: Page, url = "/") {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true", { timeout: 40_000 });
}

async function createDirtyDraft(page: Page) {
  await page.getByRole("button", { name: "Nový prípad", exact: true }).first().click();
  await page.getByLabel("EČV", { exact: true }).fill(draftPlate);
}

async function expectOpenTask(page: Page) {
  await expect(page.getByRole("heading", { name: "PM-2026-0517", exact: true })).toBeVisible();
  const task = page.locator(`#task-${taskId}`);
  await expect(task).toContainText("Zavolať klientovi o 19:00");
  await expect(task).toContainText("Otvorená úloha");
}

async function sendPushOpen(page: Page, url: string) {
  await page.evaluate((target) => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", {
    data: { type: "PM_OPEN_NOTIFICATION", url: target },
  })), url);
}
