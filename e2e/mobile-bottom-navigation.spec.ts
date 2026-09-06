import { expect, test, type Locator, type Page } from "@playwright/test";
import { isolateBrowserRequests } from "./browser-isolation";

const viewports = [
  { name: "portrait without a system inset", width: 430, height: 932, top: 0, bottom: 0, left: 0, right: 0 },
  { name: "portrait with the home indicator", width: 430, height: 932, top: 47, bottom: 34, left: 0, right: 0 },
  { name: "landscape with side insets", width: 844, height: 390, top: 0, bottom: 21, left: 47, right: 47 },
  // Preserve the browser's reported area. The layout does not impose an
  // unverified universal cap on device or accessibility configurations.
  { name: "a larger reported system inset", width: 430, height: 932, top: 47, bottom: 92, left: 0, right: 0 },
] as const;

test.describe.configure({ mode: "default" });
test.setTimeout(60_000);

test.beforeEach(async ({ page, baseURL, browserName }) => {
  test.skip(browserName !== "chromium", "True safe-area emulation uses Chromium's DevTools protocol.");
  await isolateBrowserRequests(page, baseURL!);
  await page.route("**/api/push/subscriptions*", (route) => route.fulfill({
    json: { configured: false, publicKey: null, subscribed: false, soundEnabled: true },
  }));
});

for (const viewport of viewports) {
  test(`the footer stays joined to content in ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: viewport.top, bottom: viewport.bottom, left: viewport.left, right: viewport.right },
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true", { timeout: 40_000 });
    await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute("content", "black");
    const nav = page.getByRole("navigation", { name: "Mobilná navigácia" });

    await expectJoinedFooter(page, viewport);
    await expect(nav).toHaveCSS("height", `${52 + viewport.bottom}px`);
    await expect(nav).toHaveCSS("padding-left", `${Math.max(8, viewport.left)}px`);
    await expect(nav).toHaveCSS("padding-right", `${Math.max(8, viewport.right)}px`);
    for (const label of ["Prípady", "Úlohy", "Mapa", "Menu"]) {
      await expect(nav.getByRole("button", { name: label, exact: true })).toHaveCSS("height", "44px");
      await expect(nav.getByRole("button", { name: label, exact: true })).toHaveCSS("font-size", "11px");
    }

    await page.getByTestId("dispatch-case-list").getByRole("button", { name: /^Otvoriť prípad / }).first().click();
    await expect(page.getByTestId("case-edit-form-main")).toBeVisible();
    const panel = page.locator(".dispatch-workspace-panel");
    await expect(panel).toHaveCSS("position", "absolute");
    const panelBounds = await panel.boundingBox();
    const navBounds = await nav.boundingBox();
    expect(Math.abs(panelBounds!.y + panelBounds!.height - navBounds!.y)).toBeLessThanOrEqual(4);
    const headerBounds = await page.locator(".dispatch-app-header").boundingBox();
    expect(panelBounds!.y).toBeGreaterThanOrEqual(headerBounds!.y + headerBounds!.height);
    await expectJoinedFooter(page, viewport);

    await nav.getByRole("button", { name: "Úlohy", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Zoznam úloh", exact: true })).toBeVisible();
    await expectJoinedFooter(page, viewport);
    if (viewport.bottom === 34) {
      await page.screenshot({ path: testInfo.outputPath("bottom-navigation-safe-area-34.png"), animations: "disabled" });
    }
    const lastTaskControl = page.getByTestId("task-card-page").last().getByRole("button", { name: "Upraviť", exact: true });
    await lastTaskControl.scrollIntoViewIfNeeded();
    await expectControlAboveFooter(lastTaskControl, nav);
    await expectJoinedFooter(page, viewport);

    await nav.getByRole("button", { name: "Menu", exact: true }).click();
    const menu = page.getByRole("dialog", { name: "Obrazovky aplikácie", exact: true });
    await expect(menu).toBeInViewport({ ratio: 1 });
    await expectControlAboveFooter(menu, nav);
    await menu.getByRole("button", { name: "Nastavenia", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Upozornenia a zvuk", exact: true })).toBeVisible();
    const lastSettingsControl = page.getByRole("button", { name: "Obnoviť stav", exact: true });
    await lastSettingsControl.scrollIntoViewIfNeeded();
    await expectControlAboveFooter(lastSettingsControl, nav);
    await expectJoinedFooter(page, viewport);
  });
}

async function expectJoinedFooter(page: Page, viewport: { width: number; height: number; bottom: number }) {
  const geometry = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".dispatch-app-shell")!;
    const nav = shell.querySelector<HTMLElement>(".dispatch-mobile-nav")!;
    const main = shell.querySelector<HTMLElement>(":scope > main")!;
    const shellBox = shell.getBoundingClientRect();
    const navBox = nav.getBoundingClientRect();
    const mainBox = main.getBoundingClientRect();
    return {
      shellBottom: shellBox.bottom,
      shellPadding: getComputedStyle(shell).paddingBottom,
      navTop: navBox.top,
      navBottom: navBox.bottom,
      navLeft: navBox.left,
      navRight: navBox.right,
      navHeight: navBox.height,
      navPosition: getComputedStyle(nav).position,
      mainBottom: mainBox.bottom,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      verticalOverflow: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    };
  });
  expect(geometry.shellPadding).toBe("0px");
  expect(geometry.navPosition).toBe("relative");
  expect(geometry.navHeight).toBe(52 + viewport.bottom);
  expect(Math.abs(geometry.mainBottom - geometry.navTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.navBottom - geometry.shellBottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.shellBottom - viewport.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.navLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.navRight - viewport.width)).toBeLessThanOrEqual(1);
  expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1);
  expect(geometry.verticalOverflow).toBeLessThanOrEqual(1);
}

async function expectControlAboveFooter(control: Locator, nav: Locator) {
  await expect(control).toBeInViewport({ ratio: 1 });
  const controlBox = await control.boundingBox();
  const navBox = await nav.boundingBox();
  expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(navBox!.y + 1);
}
