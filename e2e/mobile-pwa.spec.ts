import { expect, test, type Locator, type Page } from "@playwright/test";
import { isolateBrowserRequests } from "./browser-isolation";

test.describe.configure({ mode: "default" });
test.setTimeout(60_000);

test.beforeEach(async ({ page, baseURL }) => {
  await isolateBrowserRequests(page, baseURL!);
  await page.route("**/api/push/subscriptions*", (route) => route.fulfill({
    json: { configured: false, publicKey: null, subscribed: false, soundEnabled: true },
  }));
});

for (const width of [360, 390, 768, 1280]) {
  test(`mobile PWA navigation and notification settings fit at ${width}px`, async ({ page }) => {
    const mobile = width < 1024;
    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await openDashboard(page);
    const shell = page.getByTestId("dispatch-console");
    const cases = page.getByTestId("dispatch-case-list");
    const navigation = page.getByRole("navigation", { name: "Mobilná navigácia" });

    await expect(cases).toBeVisible();
    if (mobile) {
      await expect(navigation).toBeVisible();
      await expect(navigation.locator('[aria-current="page"]')).toHaveAccessibleName("Prípady");
      await expect(shell).toHaveAttribute("data-mobile-pane", "cases");
      await expect(page.locator(".mobile-dispatch-workspace")).toBeHidden();
      await expect(cases.getByRole("textbox")).toHaveCSS("font-size", "16px");
      const cards = cases.getByRole("button", { name: /^Otvoriť prípad / });
      await expect(cards.first()).toBeVisible();
      await cards.last().scrollIntoViewIfNeeded();
      await expectAboveNavigation(cards.last(), navigation);
      await cards.first().scrollIntoViewIfNeeded();
    } else {
      await expect(navigation).toBeHidden();
      await expect(page.getByTestId("dashboard-task-panel-shell")).toBeVisible();
    }
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ animations: "disabled", path: `.context/mobile-cases-${width}.png` });

    if (mobile) {
      await cases.getByRole("button", { name: /^Otvoriť prípad / }).first().click();
      await expect(page.getByTestId("case-edit-form-main")).toBeVisible();
      await expect(cases).toBeHidden();
      await expect(navigation.locator('[aria-current="page"]')).toHaveAccessibleName("Prípady");
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ animations: "disabled", path: `.context/mobile-case-${width}.png` });
      await navigation.getByRole("button", { name: "Mapa", exact: true }).click();
      await expect(shell).toHaveAttribute("data-mobile-pane", "workspace");
      await expect(navigation.locator('[aria-current="page"]')).toHaveAccessibleName("Mapa");
      await expect(page.locator("#dispatch-workspace-shell")).toHaveAttribute("data-workspace-mode", "collapsed");
      await expect(cases).toBeHidden();
      await expectAboveNavigation(page.getByRole("button", { name: "Maximalizovať spodnú lištu", exact: true }), navigation);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ animations: "disabled", path: `.context/mobile-map-${width}.png` });
    }

    await navigate(page, "Úlohy");
    const createForm = page.locator("#new-task-form");
    await expect(page.getByRole("heading", { name: "Zoznam úloh", exact: true })).toBeVisible();
    if (mobile) {
      await expect(navigation.locator('[aria-current="page"]')).toHaveAccessibleName("Úlohy");
      await expect(createForm).toBeHidden();
      await page.screenshot({ animations: "disabled", path: `.context/mobile-tasks-${width}.png` });
      await page.getByRole("button", { name: "Nová úloha", exact: true }).click();
      await expect(createForm).toBeVisible();
      await expect(createForm.getByLabel("Názov úlohy", { exact: true })).toHaveCSS("font-size", "16px");
      await createForm.getByRole("button", { name: "Vytvoriť úlohu", exact: true }).scrollIntoViewIfNeeded();
      await expectAboveNavigation(createForm.getByRole("button", { name: "Vytvoriť úlohu", exact: true }), navigation);
      await page.screenshot({ animations: "disabled", path: `.context/mobile-task-form-${width}.png` });
    } else {
      await expect(createForm).toBeVisible();
    }
    await expectNoHorizontalOverflow(page);

    await navigate(page, "Nastavenia");
    const settings = page.getByRole("navigation", { name: "Sekcie nastavení" });
    await expect(settings.getByRole("button").first()).toHaveAccessibleName("Upozornenia");
    await expect(settings.getByRole("button", { name: "Upozornenia", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Upozornenia a zvuk", exact: true })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Push upozornenia na tomto zariadení", exact: true })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Zvuk upozornení", exact: true })).toBeVisible();
    if (mobile) {
      const lastControl = page.getByRole("button", { name: "Obnoviť stav", exact: true });
      await lastControl.scrollIntoViewIfNeeded();
      await expectAboveNavigation(lastControl, navigation);
    }
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ animations: "disabled", path: `.context/mobile-settings-${width}.png` });

    const header = page.locator("header.dispatch-app-header");
    await header.getByRole("button", { name: /^Upozornenia/ }).click();
    const history = page.getByRole("dialog", { name: "História upozornení", exact: true });
    await expect(history).toBeVisible();
    await expectNoHorizontalOverflow(page);
    if (mobile) {
      await expectAboveNavigation(history, navigation);
      await history.getByRole("button", { name: "Zavrieť upozornenia", exact: true }).click();
    } else {
      await page.keyboard.press("Escape");
    }

    if (mobile) await navigation.getByRole("button", { name: "Prípady", exact: true }).click();
    await page.getByRole("button", { name: "Nový prípad", exact: true }).first().click();
    await page.getByLabel("EČV", { exact: true }).fill("MOBILE QA");
    await navigate(page, "Úlohy");
    const unsaved = page.getByRole("dialog", { name: "Rozpracovaný prípad nie je uložený", exact: true });
    await expect(unsaved).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await unsaved.getByRole("button", { name: "Zostať vo formulári", exact: true }).last().click();
    await expect(page.getByLabel("EČV", { exact: true })).toHaveValue("MOBILE QA");
    await navigate(page, "Úlohy");
    await unsaved.getByRole("button", { name: "Odísť bez uloženia", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Zoznam úloh", exact: true })).toBeVisible();
    expect(runtimeErrors).toEqual([]);
  });
}

test("mobile landscape keeps navigation reachable at 844 by 390", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await openDashboard(page);
  const nav = page.getByRole("navigation", { name: "Mobilná navigácia" });
  await expect(nav).toBeInViewport({ ratio: 1 });
  await expectNoHorizontalOverflow(page);
  await nav.getByRole("button", { name: "Mapa", exact: true }).click();
  await expect(nav.locator('[aria-current="page"]')).toHaveAccessibleName("Mapa");
  await expect(nav).toBeInViewport({ ratio: 1 });
  await expectNoHorizontalOverflow(page);
  await nav.getByRole("button", { name: "Úlohy", exact: true }).click();
  await expect(nav.locator('[aria-current="page"]')).toHaveAccessibleName("Úlohy");
  await expect(page.getByRole("button", { name: "Nová úloha", exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await nav.getByRole("button", { name: "Prípady", exact: true }).click();
  await expect(nav.locator('[aria-current="page"]')).toHaveAccessibleName("Prípady");
  await expect(page.getByTestId("dispatch-case-list")).toBeVisible();
  await page.screenshot({ animations: "disabled", path: ".context/mobile-landscape-844.png" });
});

async function openDashboard(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true", { timeout: 40_000 });
}

async function navigate(page: Page, label: string) {
  const mobile = (page.viewportSize()?.width ?? 1280) < 1024;
  const nav = page.getByRole("navigation", { name: mobile ? "Mobilná navigácia" : "Hlavná navigácia" });
  if (mobile && label === "Úlohy") {
    await nav.getByRole("button", { name: label, exact: true }).click();
    return;
  }
  await nav.getByRole("button", { name: "Menu", exact: true }).click();
  await nav.getByRole("dialog", { name: "Obrazovky aplikácie" }).getByRole("button", { name: new RegExp(`^${label}(?: \\d+)?$`) }).click();
}

async function expectAboveNavigation(content: Locator, navigation: Locator) {
  await expect(content).toBeInViewport();
  const contentBox = await content.boundingBox();
  const navBox = await navigation.boundingBox();
  expect(contentBox!.y + contentBox!.height).toBeLessThanOrEqual(navBox!.y + 1);
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}
