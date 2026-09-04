import { expect, test, type Locator, type Page } from "@playwright/test";
import type { DispatchData } from "../src/data/dispatch-types";
import {
  attendance as mockAttendance,
  branches as mockBranches,
  callCenterCalls as mockCallCenterCalls,
  dispatchCases as mockDispatchCases,
  fleetAssets as mockFleetAssets,
  incomingCall as mockIncomingCall,
  integrations as mockIntegrations,
  metrics as mockMetrics,
  notifications as mockNotifications,
  operators as mockOperators,
  priceRules as mockPriceRules,
} from "../src/mock/seed";

// These scenarios all boot the data-heavy dispatch dashboard against the same
// development server. Running the viewport matrix serially keeps the smoke
// suite deterministic on CI-sized workers without changing production code.
test.describe.configure({ mode: "serial" });

const viewportWidths = [390, 768, 1024, 1280, 1440] as const;
const viewportHeight = 900;

for (const width of viewportWidths) {
  test(`public shell has no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: viewportHeight });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toBeVisible();

    await expectNoDocumentOverflow(page, `public shell at ${width}px`);
  });

  test(`dashboard and empty case card fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: viewportHeight });
    await openDashboard(page);

    await expect(page.getByTestId("signed-in-user-name")).toBeVisible();
    await expect(page.getByText("Linka pomoci motoristom", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Nástenka", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Telefónne číslo alebo meno kontaktu" })).toBeVisible();
    await expectNoDocumentOverflow(page, `dashboard at ${width}px`);
    if (width >= 1280) {
      await expectNoElementOverflow(page.getByTestId("dashboard-task-panel-shell"), `task panel at ${width}px`);
    }

    await openNewCase(page);
    await expect(page.getByRole("heading", { name: "Kontrola karty", exact: true })).toHaveCount(0);
    await expect(page.locator("[data-form-section-state]").first()).toHaveAttribute("data-form-section-state", "invalid");

    const plate = page.getByLabel("EČV", { exact: true });
    const primaryFirstName = page.getByLabel("Meno", { exact: true }).first();
    const make = page.getByLabel("Značka", { exact: true });
    const model = page.getByLabel("Model", { exact: true });
    await expect(plate).toHaveValue("");
    await expect(primaryFirstName).toHaveValue("");
    await expect(primaryFirstName).toHaveAttribute("aria-required", "true");
    await expect(page.getByText("Kontakt bol predvyplnený z hovoru", { exact: false })).toHaveCount(0);
    await expect(make).toHaveValue("");
    await expect(model).toHaveValue("");
    await expect(plate).toHaveAttribute("aria-required", "true");
    expect(await page.getByTestId("case-form-main").locator("[data-required-marker]").count()).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "Uložiť rozpracované", exact: true }).first()).toBeEnabled();
    await expect(page.getByLabel("Adresár firiem", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Asistenčná služba", { exact: true })).toHaveCount(0);

    await plate.fill("E2E TEST");
    await make.fill("Test");
    await model.fill("Vozidlo");
    await expect(plate).toHaveValue("E2E TEST");
    await expect(make).toHaveValue("Test");
    await expect(model).toHaveValue("Vozidlo");

    await expectNoDocumentOverflow(page, `new case card at ${width}px`, "[data-testid='case-form-scroll-region']");
    await expectCaseFormUsesFullWidth(page, `new case card at ${width}px`);
  });
}

test("case header offers separate web and mobile call actions", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await openDashboard(page);
  await page.getByRole("button", { name: mockDispatchCases[0].caseNumber, exact: true }).click();

  const callActions = page.getByRole("group", { name: "Možnosti volania", exact: true });
  await expect(callActions).toBeVisible();
  await expect(callActions.getByRole("button", { name: "Volať cez web", exact: true })).toBeVisible();
  await expect(callActions.getByRole("link", { name: "Volať cez mobil", exact: true })).toHaveAttribute("href", /^tel:\+?\d/);

  await page.setViewportSize({ width: 390, height: viewportHeight });
  await expect(callActions).toBeVisible();
  await expect(callActions.locator("xpath=..").getByRole("button", { name: "SMS", exact: true })).toBeVisible();
  await expectNoDocumentOverflow(page, "case call actions at 390px");
});

test("replacement vehicle details stay in place while the explicit choice changes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await openDashboard(page);
  await openNewCase(page);

  const vehicleType = page.getByLabel("Požadovaný typ vozidla", { exact: true });
  const specialRequirements = page.getByLabel("Špeciálne požiadavky", { exact: true });
  const yesButton = page.getByRole("button", { name: "Áno, potrebuje", exact: true });
  const noButton = page.getByRole("button", { name: "Nie, nepotrebuje", exact: true });

  await expect(page.getByRole("button", { name: "Súkromná osoba", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(noButton).toHaveAttribute("aria-pressed", "true");
  await expect(noButton).toHaveClass(/bg-yellow-100/);
  await expect(yesButton).toHaveClass(/bg-zinc-50/);
  await expect(page.getByRole("checkbox", { name: "Pojazdné", exact: true })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Nepojazdné", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pojazdné", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Nepojazdné", exact: true })).toHaveCount(1);
  await expect(vehicleType).toBeVisible();
  await expect(vehicleType).toBeDisabled();
  await expect(specialRequirements).toBeDisabled();

  await yesButton.click();
  await expect(yesButton).toHaveAttribute("aria-pressed", "true");
  await expect(yesButton).toHaveClass(/bg-yellow-100/);
  await expect(noButton).toHaveClass(/bg-zinc-50/);
  await expect(vehicleType).toBeEnabled();
  await expect(vehicleType).toHaveAttribute("aria-required", "true");
  await expect(specialRequirements).toBeEnabled();
  await vehicleType.fill("Kombi");

  await noButton.click();
  await expect(vehicleType).toBeVisible();
  await expect(vehicleType).toBeDisabled();
  await expect(vehicleType).toHaveValue("Kombi");
});

test("edit form shows required fields and uses one selected replacement-vehicle color", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await openCaseEdit(page);

  const editForm = page.getByTestId("case-edit-form-main");
  const yesButton = editForm.getByRole("button", { name: "Áno, potrebuje", exact: true });
  const noButton = editForm.getByRole("button", { name: "Nie, nepotrebuje", exact: true });

  await expect(editForm.getByLabel("EČV", { exact: true })).toHaveAttribute("aria-required", "true");
  await expect(editForm.getByLabel("Meno", { exact: true }).first()).toHaveAttribute("aria-required", "true");
  expect(await editForm.locator("[data-required-marker]").count()).toBeGreaterThan(0);

  await noButton.click();
  await expect(noButton).toHaveClass(/bg-yellow-100/);
  await expect(yesButton).toHaveClass(/bg-zinc-50/);

  await yesButton.click();
  await expect(yesButton).toHaveClass(/bg-yellow-100/);
  await expect(noButton).toHaveClass(/bg-zinc-50/);
});

test("a missing Places key still allows a manual text location", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await openDashboard(page);
  await openNewCase(page);

  const manualLocation = page.getByLabel("Ručne zadaná adresa alebo opis miesta", { exact: true });
  await expect(manualLocation).toBeVisible();
  await manualLocation.fill("R1, smer Nitra, približne pri 42. kilometri");

  const locationSection = page
    .getByRole("heading", { name: "4. Miesto a cieľ", exact: true })
    .locator("xpath=ancestor::section[@data-form-section-state]");
  await expect(locationSection).toHaveAttribute("data-form-section-state", "valid");
  await expect(page.getByText("Kartu môžete uložiť aj bez súradníc.", { exact: false })).toBeVisible();
});

test("constrained fields prevent letters and invalid identifier characters", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await openDashboard(page);
  await openNewCase(page);

  const productionYear = page.getByLabel("Rok výroby", { exact: true });
  const phone = page.locator("input[type='tel']").first();
  const vin = page.getByRole("textbox", { name: /^VIN/ });

  await expect(productionYear).toHaveAttribute("type", "number");
  await productionYear.pressSequentially("Hello2026");
  await expect(productionYear).toHaveValue("2026");

  await phone.fill("abc 900 xyz 123 456");
  await expect(phone).toHaveValue("900123456");

  await vin.fill("wba-i-o-q123456789012345");
  await expect(vin).toHaveValue("WBA12345678901234");
});

test("edit validates an assistance-service contact email inline", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await openCaseEdit(page);
  await page.getByRole("button", { name: "Asistenčná služba", exact: true }).click();

  const email = page.getByLabel("Email", { exact: true }).first();
  await email.fill("operator@assistance");
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Email nemá správny formát.", { exact: true }).first()).toBeVisible();

  await email.fill("operator@assistance.sk");
  await expect(email).toHaveAttribute("aria-invalid", "false");
});

test("validation stays visible while an incomplete case can still be saved as a draft", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await openDashboard(page);
  await openNewCase(page);

  await expect(page.getByRole("button", { name: "Uložiť rozpracované", exact: true }).first()).toBeEnabled();

  await page.getByRole("checkbox", { name: "Asistencia na mieste", exact: true }).check();
  await page.getByRole("button", { name: "Súkromná osoba", exact: true }).click();
  await page.getByLabel("Meno", { exact: true }).fill("Ján");
  await page.locator("input[type='tel']").first().fill("900 123 456");
  await page.getByLabel("EČV", { exact: true }).fill("BA123AB");
  await page.getByLabel("Opis problému / situácie", { exact: true }).fill("Vozidlo sa nedá naštartovať.");
  await page.getByRole("button", { name: "Nepojazdné", exact: true }).click();
  await page.getByRole("combobox", { name: "Typ incidentu", exact: true }).selectOption("breakdown");
  await page.getByPlaceholder("napr. R1 pri Nitre alebo 48.1486, 17.1077").fill("48.1486, 17.1077");
  await page.getByRole("button", { name: "Nájsť", exact: true }).click();
  await page.getByRole("button", { name: "Nie, nepotrebuje", exact: true }).click();

  await expect(page.getByRole("button", { name: "Uložiť kartu", exact: true }).first()).toBeEnabled();
  await expect(page.locator("[data-form-section-state='valid']")).toHaveCount(5);

  const vin = page.getByRole("textbox", { name: /^VIN/ });
  await vin.fill("123");
  await expect(page.getByRole("button", { name: "Uložiť rozpracované", exact: true }).first()).toBeEnabled();
  await expect(page.getByText("VIN musí mať 17 znakov a nesmie obsahovať I, O ani Q.", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "3. Vozidlo a incident", exact: true }).locator("xpath=ancestor::section[@data-form-section-state]")).toHaveAttribute("data-form-section-state", "invalid");

  await vin.fill("WVWZZZ1JZXW000001");
  await expect(page.getByRole("button", { name: "Uložiť kartu", exact: true }).first()).toBeEnabled();
  await expect(page.locator("[data-form-section-state='valid']")).toHaveCount(5);
});

test("an entirely empty case can be persisted as a draft", async ({ page }) => {
  let submittedPayload: Record<string, unknown> | null = null;
  const savedCase = mockDispatchCases[0];

  await page.route("**/api/cases", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    submittedPayload = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      json: {
        caseId: savedCase.id,
        dispatchData: createMockDispatchData(),
        warnings: [],
      },
    });
  });

  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await openDashboard(page);
  await openNewCase(page);
  await page.getByRole("button", { name: "Uložiť rozpracované", exact: true }).click();

  await expect.poll(() => submittedPayload).not.toBeNull();
  expect(submittedPayload).toMatchObject({
    contactName: "",
    contactPhone: "",
    jobTypes: [],
    licensePlate: "",
  });
  expect(submittedPayload).not.toHaveProperty("caseType");
  expect(submittedPayload).not.toHaveProperty("sourceType");
  await expect(page.getByText("Karta je uložená ako rozpracovaná.", { exact: false })).toBeVisible();
});

test("leaving a new case uses the in-app save-or-discard dialog", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await openDashboard(page);
  await openNewCase(page);
  await page.getByLabel("Interná poznámka dispečera", { exact: true }).fill("Rozpracovaný telefonát");

  const mainNavigation = page.getByRole("navigation", { name: "Hlavná navigácia" });
  await mainNavigation.getByRole("button", { name: "Menu", exact: true }).click();
  const tasksNavigation = mainNavigation.getByRole("menuitem", { name: /Úlohy/ });
  await tasksNavigation.click();
  await expect(page.getByRole("dialog")).toContainText("Rozpracovaný prípad nie je uložený");
  await page.getByRole("button", { name: "Zostať vo formulári", exact: true }).first().click();
  await expect(page.getByLabel("Interná poznámka dispečera", { exact: true })).toHaveValue("Rozpracovaný telefonát");

  await mainNavigation.getByRole("button", { name: "Menu", exact: true }).click();
  await tasksNavigation.click();
  await page.getByRole("button", { name: "Odísť bez uloženia", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Úlohy", exact: true })).toBeVisible();
});

test("an employee can quick-add an assistance service from the case form", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await openDashboard(page);
  await page.route("**/api/partner-directory/assistance", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ name: "E2E asistencia" });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        dispatchData: {
          partnerDirectory: [
            {
              id: "e2e-assistance",
              active: true,
              kind: "assistance",
              name: "E2E asistencia",
            },
          ],
        },
      }),
    });
  });
  await openNewCase(page);

  await page.getByRole("button", { name: "Asistenčná služba", exact: true }).click();
  await page.getByLabel("Asistenčná služba", { exact: true }).fill("E2E asistencia");
  await page.getByRole("button", { name: "Uložiť", exact: true }).click();

  await expect(page.getByText("Uložené do adresára.", { exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "E2E asistencia", exact: true })).toHaveJSProperty("selected", true);
});

test("public responses include the baseline security headers", async ({ page }) => {
  const response = await page.goto("/", { waitUntil: "domcontentloaded" });

  expect(response).not.toBeNull();
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response?.headers()["x-frame-options"]).toBe("DENY");
  expect(response?.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(response?.headers()["x-powered-by"]).toBeUndefined();
});

test.describe("Slovak browser timezone", () => {
  test.use({ timezoneId: "Europe/Bratislava" });

  test("dashboard hydrates without replacing the page", async ({ page }) => {
    const hydrationErrors: string[] = [];
    const hydrationPattern = /Hydration failed|server rendered text didn't match|Minified React error #418|react\.dev\/errors\/418/i;
    page.on("pageerror", (error) => {
      if (hydrationPattern.test(error.message)) {
        hydrationErrors.push(error.message);
      }
    });
    page.on("console", (message) => {
      if (message.type() === "error" && hydrationPattern.test(message.text())) {
        hydrationErrors.push(message.text());
      }
    });

    await openDashboard(page);
    await page.waitForTimeout(500);

    expect(hydrationErrors).toEqual([]);
  });
});

test("dashboard phone validates a missing number before dialing", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await openDashboard(page);

  await page.getByRole("button", { name: "Volať", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Zadajte platné telefónne číslo" })).toBeVisible();
});

test("dashboard side columns resize horizontally and keep the preference", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: viewportHeight });
  await openDashboard(page);

  const leftResize = page.getByRole("separator", { name: "Zmeniť šírku stĺpca prípadov", exact: true });
  const rightResize = page.getByRole("separator", { name: "Zmeniť šírku stĺpca úloh a upozornení", exact: true });
  await expect(leftResize).toBeVisible();
  await expect(rightResize).toBeVisible();

  const leftBox = await leftResize.boundingBox();
  expect(leftBox).not.toBeNull();
  await page.mouse.move(leftBox!.x + leftBox!.width / 2, leftBox!.y + 120);
  await page.mouse.down();
  await page.mouse.move(leftBox!.x + leftBox!.width / 2 + 40, leftBox!.y + 120, { steps: 4 });
  await page.mouse.up();
  await expect(leftResize).toHaveAttribute("aria-valuenow", "370");

  const rightBox = await rightResize.boundingBox();
  expect(rightBox).not.toBeNull();
  await page.mouse.move(rightBox!.x + rightBox!.width / 2, rightBox!.y + 120);
  await page.mouse.down();
  await page.mouse.move(rightBox!.x + rightBox!.width / 2 - 30, rightBox!.y + 120, { steps: 3 });
  await page.mouse.up();
  await expect(rightResize).toHaveAttribute("aria-valuenow", "360");
  const firstSidebarTask = page.getByTestId("task-card-sidebar").first();
  await expect(firstSidebarTask.locator(".dashboard-task-card-actions > div")).toHaveCSS("flex-direction", "column");

  const widerRightBox = await rightResize.boundingBox();
  expect(widerRightBox).not.toBeNull();
  await page.mouse.move(widerRightBox!.x + widerRightBox!.width / 2, widerRightBox!.y + 120);
  await page.mouse.down();
  await page.mouse.move(widerRightBox!.x + widerRightBox!.width / 2 - 120, widerRightBox!.y + 120, { steps: 4 });
  await page.mouse.up();
  await expect(rightResize).toHaveAttribute("aria-valuenow", "480");
  await expect(firstSidebarTask.locator(".dashboard-task-card-actions > div")).toHaveCSS("flex-direction", "row");
  expect(Math.round((await firstSidebarTask.boundingBox())!.height)).toBeLessThanOrEqual(90);
  await expectNoDocumentOverflow(page, "resized dashboard columns");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true", { timeout: 30_000 });
  await expect(leftResize).toHaveAttribute("aria-valuenow", "370");
  await expect(rightResize).toHaveAttribute("aria-valuenow", "480");

  await leftResize.dblclick();
  await rightResize.dblclick();
  await expect(leftResize).toHaveAttribute("aria-valuenow", "330");
  await expect(rightResize).toHaveAttribute("aria-valuenow", "330");

  await page.setViewportSize({ width: 1024, height: viewportHeight });
  await expect(leftResize).toBeVisible();
  await expect(rightResize).toBeHidden();
  await expectNoDocumentOverflow(page, "dashboard columns at 1024px");

  await page.setViewportSize({ width: 768, height: viewportHeight });
  await expect(leftResize).toBeHidden();
  await expect(rightResize).toBeHidden();
  await expectNoDocumentOverflow(page, "dashboard columns at 768px");
});

test("task sidebar stays focused and the full task filters work together", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: viewportHeight });
  await openDashboard(page);

  const sidebar = page.getByTestId("dashboard-task-panel-shell");
  const navigation = page.getByRole("navigation", { name: "Hlavná navigácia" });
  await expect(sidebar.getByRole("heading", { name: "Úlohy", exact: true })).toHaveCount(0);
  await expect(sidebar.getByText("Úlohy a operátori", { exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("combobox", { name: /Operátor/ })).toHaveCount(0);
  const sidebarFilters = sidebar.getByRole("group", { name: "Filtrovanie úloh podľa priradenia" });
  await expect(sidebarFilters.getByRole("button")).toHaveCount(2);
  await expect(sidebarFilters.getByRole("button", { name: /Moje/ })).toBeVisible();
  await expect(sidebarFilters.getByRole("button", { name: /Všetky/ })).toHaveAttribute("aria-pressed", "true");
  const sidebarTaskHeights = await sidebar.getByTestId("task-card-sidebar").evaluateAll((cards) =>
    cards.map((card) => Math.round(card.getBoundingClientRect().height)),
  );
  expect(sidebarTaskHeights.length).toBeGreaterThan(0);
  expect(Math.max(...sidebarTaskHeights)).toBeLessThanOrEqual(120);

  const activeCaseHeights = await page.locator("[data-case-number]").evaluateAll((cards) =>
    cards.map((card) => Math.round(card.getBoundingClientRect().height)),
  );
  expect(activeCaseHeights.length).toBeGreaterThan(0);
  expect(Math.max(...activeCaseHeights)).toBeLessThanOrEqual(100);

  await navigation.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(navigation.getByRole("menuitem", { name: "Ústredňa", exact: true })).toBeVisible();
  await expectNoElementOverflow(sidebar, "dashboard task sidebar");

  await navigation.getByRole("menuitem", { name: /Úlohy/ }).click();
  await expect(page.getByRole("heading", { name: "Nová úloha", exact: true })).toBeVisible();
  const taskTitleInput = page.getByLabel("Názov úlohy", { exact: true });
  await expect(taskTitleInput).toBeVisible();
  expect(await taskTitleInput.evaluate((element) => element.tagName)).toBe("TEXTAREA");
  await expect(taskTitleInput).toHaveAttribute("rows", "3");
  await expect(page.getByLabel("Termín", { exact: true })).toBeVisible();

  const operatorFilter = page.getByRole("combobox", { name: /Operátor/ });
  await expect(operatorFilter).toHaveValue("all");
  await operatorFilter.selectOption({ label: "Mango" });
  await expect(page.getByText("Overiť nízku plošinu", { exact: true })).toBeVisible();
  await expect(page.getByText("Zavolať klientovi o 19:00", { exact: true })).toHaveCount(0);

  const createTaskForm = page.locator('section[aria-labelledby="new-task-heading"]');
  const formHeightBeforeFilter = await createTaskForm.evaluate((element) => element.getBoundingClientRect().height);
  await page.getByRole("group", { name: "Stav úlohy" }).getByRole("button", { name: /Vybavené/ }).click();
  const formHeightAfterFilter = await createTaskForm.evaluate((element) => element.getBoundingClientRect().height);
  expect(Math.abs(formHeightAfterFilter - formHeightBeforeFilter)).toBeLessThanOrEqual(1);

  await page.getByLabel("Názov úlohy", { exact: true }).fill("E2E nová úloha");
  await page.getByRole("button", { name: "Vytvoriť úlohu", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "E2E nová úloha" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Práve vytvorené", exact: true })).toBeVisible();
  await expect(page.getByText("E2E nová úloha", { exact: true })).toBeVisible();
  await expect(page.getByText("Nová", { exact: true })).toBeVisible();
  await expect(operatorFilter).toHaveValue("all");
  await expectNoDocumentOverflow(page, "task workspace");
});

test("dashboard tasks can be edited inline with a multiline title", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: viewportHeight });
  await openDashboard(page);

  const sidebar = page.getByTestId("dashboard-task-panel-shell");
  await sidebar.getByRole("button", { name: "Upraviť", exact: true }).first().click();

  const titleEditor = sidebar.getByRole("textbox", { name: /^Názov úlohy / }).first();
  await expect(titleEditor).toBeVisible();
  expect(await titleEditor.evaluate((element) => element.tagName)).toBe("TEXTAREA");
  await expect(titleEditor).toHaveAttribute("rows", "3");
  await titleEditor.fill("Upravená úloha\ns dlhším detailom");
  await sidebar.getByRole("button", { name: "Uložiť", exact: true }).click();

  await expect(sidebar.getByText(/Upravená úloha\s+s dlhším detailom/)).toBeVisible();
  await expectNoElementOverflow(sidebar, "inline task editor");
});

test("dispatch case sidebar searches case numbers and exposes operational sorting details", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: viewportHeight });
  await openDashboard(page);

  const sidebar = page.getByTestId("dispatch-case-list");
  const search = sidebar.getByRole("textbox", { name: "Hľadať podľa čísla prípadu, telefónu, EČV alebo mesta" });
  await search.fill("PM20260516");

  const assistanceCase = sidebar.locator('[data-case-number="PM-2026-0516"]');
  await expect(assistanceCase).toBeVisible();
  await expect(assistanceCase.getByText("Asistenčná služba: Europe Assistance", { exact: true })).toBeVisible();
  await expect(assistanceCase.getByText("Úlohy 1", { exact: true })).toBeVisible();
  await expect(sidebar.locator("[data-case-number]")).toHaveCount(1);

  await search.clear();
  const sort = sidebar.getByRole("combobox", { name: "Zoradiť prípady" });
  await sort.selectOption("priority");
  const priorityRanks = await sidebar.locator("[data-case-priority]").evaluateAll((elements) => {
    const rank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
    return elements.map((element) => rank[element.getAttribute("data-case-priority") ?? ""] ?? 99);
  });
  expect(priorityRanks).toEqual([...priorityRanks].sort((left, right) => left - right));

  await sort.selectOption("updatedAt");
  await expect(sort).toHaveValue("updatedAt");
  await sort.selectOption("openTasks");
  const taskCounts = await sidebar.locator("[data-open-task-count]").evaluateAll((elements) =>
    elements.map((element) => Number(element.getAttribute("data-open-task-count") ?? 0)),
  );
  expect(taskCounts).toEqual([...taskCounts].sort((left, right) => right - left));
  await expectNoElementOverflow(sidebar, "dispatch case sidebar");
});

test("case cockpit edits in compact sections and keeps operational details available", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: viewportHeight });
  await openDashboard(page);

  const editor = page.getByTestId("case-edit-form-main");
  const sections = editor.locator("details[data-form-section-state]");
  await expect(editor).toBeVisible();
  await expect(sections).toHaveCount(5);
  await expect(sections.nth(0)).toHaveAttribute("open", "");
  await expect(sections.nth(1)).not.toHaveAttribute("open", "");
  await expect(page.getByRole("button", { name: "Otvoriť úplnú kartu" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Upraviť kartu", exact: true })).toHaveCount(0);

  await sections.nth(1).locator("summary").click();
  await expect(sections.nth(1)).toHaveAttribute("open", "");
  await expect(sections.nth(1).getByLabel("Meno", { exact: true }).first()).toBeVisible();

  const operationalOverview = page.locator("details").filter({ hasText: "Prevádzkový prehľad" }).first();
  await expect(operationalOverview).not.toHaveAttribute("open", "");
  await operationalOverview.locator("summary").click();
  await expect(operationalOverview).toHaveAttribute("open", "");
  await expect(operationalOverview.getByText("Ďalší krok", { exact: true })).toBeVisible();
});

test("compact case editor protects a pending change before it collapses", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: viewportHeight });
  await openDashboard(page);

  await page.getByLabel("Priorita", { exact: true }).selectOption("low");
  await expect(page.getByTestId("case-autosave-status")).toContainText("Čakám na dokončenie zmeny");
  await page.keyboard.press("Escape");

  const leaveDialog = page.getByRole("dialog").filter({ hasText: "Na karte sú neuložené zmeny" });
  await expect(leaveDialog).toBeVisible();
  await leaveDialog.getByRole("button", { name: "Zostať vo formulári", exact: true }).last().click();
  await expect(page.getByTestId("case-edit-form-main")).toBeVisible();
});

test("case directory keeps its context and creates a task for the selected person", async ({ page }) => {
  let submittedTask: Record<string, unknown> | null = null;
  await page.route("**/api/cases/*/actions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    submittedTask = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 200, json: { dispatchData: createMockDispatchData() } });
  });
  await page.setViewportSize({ width: 1440, height: viewportHeight });
  await openDashboard(page);

  const navigation = page.getByRole("navigation", { name: "Hlavná navigácia" });
  await navigation.getByRole("button", { name: "Menu", exact: true }).click();
  const casesNavigation = navigation.getByRole("menuitem", { name: "Prípady", exact: true });
  await casesNavigation.click();
  await page.locator("tbody tr").first().click();

  await expect(page.getByTestId("case-edit-form-main")).toBeVisible();
  await navigation.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(navigation.getByRole("menuitem", { name: "Prípady", exact: true })).toHaveAttribute("aria-current", "page");
  await navigation.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Úlohy prípadu", exact: true })).toBeVisible();
  await page.getByLabel("Názov novej úlohy").fill("Overiť klienta");
  await page.getByLabel("Zodpovedná osoba").last().selectOption(mockOperators[1].id);
  await page.getByRole("button", { name: "Pridať úlohu", exact: true }).last().click();

  await expect.poll(() => submittedTask).not.toBeNull();
  expect(submittedTask).toMatchObject({
    action: "create_task",
    assignedTo: mockOperators[1].id,
    taskTitle: "Overiť klienta",
  });
});

test("task inputs stay readable in a narrow case detail", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: viewportHeight });
  await openCaseEdit(page);

  const taskForm = page.getByRole("heading", { name: "Pridať novú úlohu", exact: true }).locator("..");
  const titleInput = taskForm.getByLabel("Názov novej úlohy", { exact: true });
  const dueAtInput = taskForm.getByLabel("Termín úlohy", { exact: true });

  await expect(titleInput).toBeVisible();
  await expect(dueAtInput).toBeVisible();
  await expect(dueAtInput).toHaveCSS("font-size", "16px");

  const titleBox = await titleInput.boundingBox();
  const dueAtBox = await dueAtInput.boundingBox();
  expect(titleBox).not.toBeNull();
  expect(dueAtBox).not.toBeNull();
  expect(dueAtBox!.width).toBeGreaterThan(250);
  expect(Math.abs(dueAtBox!.width - titleBox!.width)).toBeLessThanOrEqual(1);
  await expectNoElementOverflow(taskForm, "task form at 1024px");
});

test("quick dial shows favorite contacts in pages of five", async ({ page }) => {
  const favorites = Array.from({ length: 6 }, (_, index) => ({
    id: `favorite-${index + 1}`,
    name: `Obľúbený kontakt ${index + 1}`,
    phone: `+421 900 000 00${index + 1}`,
    role: "client" as const,
    isFavorite: true,
  }));
  await page.route("**/api/telephony/directory/favorites", (route) => route.fulfill({ json: { favorites } }));

  await page.setViewportSize({ width: 1440, height: viewportHeight });
  await openDashboard(page);

  const favoritesPanel = page.locator('section[aria-label="Obľúbené kontakty na rýchle volanie"]');
  await expect(favoritesPanel).toBeVisible();
  await expect(favoritesPanel.getByRole("button", { name: /Volať kontaktu Obľúbený kontakt/ })).toHaveCount(5);
  await expect(favoritesPanel.getByRole("button", { name: "Volať kontaktu Obľúbený kontakt 6", exact: true })).toHaveCount(0);
  await favoritesPanel.getByRole("button", { name: "Nasledujúca strana obľúbených kontaktov" }).click();
  await expect(favoritesPanel.getByRole("button", { name: "Volať kontaktu Obľúbený kontakt 6", exact: true })).toBeVisible();
  await expect(favoritesPanel.getByText("2 / 2", { exact: true })).toBeVisible();
  await expectNoElementOverflow(favoritesPanel, "quick dial favorites");
});

test("dashboard phone searches, favorites, and reports the missing telephony setup on dial", async ({ page }) => {
  const contact = {
    id: "00000000-0000-4000-8000-000000000123",
    name: "Peter Kováč",
    phone: "+421 900 123 456",
    email: "peter@example.test",
    role: "client",
    isFavorite: false,
  } as const;

  await page.route("**/api/telephony/directory/favorites", (route) => route.fulfill({ json: { favorites: [] } }));
  await page.route("**/api/telephony/directory/favorites/*", async (route) => {
    await route.fulfill({ json: { contact: { ...contact, isFavorite: true }, contactId: contact.id, isFavorite: true } });
  });
  await page.route("**/api/telephony/directory?*", (route) => route.fulfill({ json: { contacts: [contact] } }));

  await page.setViewportSize({ width: 1280, height: viewportHeight });
  const favoritesLoaded = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/telephony/directory/favorites",
  );
  await openDashboard(page);
  await favoritesLoaded;

  const phoneInput = page.getByRole("combobox", { name: "Telefónne číslo alebo meno kontaktu" });
  const phonePanel = phoneInput.locator("xpath=ancestor::section");
  const searchLoaded = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/telephony/directory" && url.searchParams.get("q") === "Peter";
  });
  await phoneInput.fill("Peter");
  await searchLoaded;
  const option = page.getByRole("option").filter({ hasText: contact.name });
  await expect(option).toBeVisible();
  await option.getByRole("button", { name: `Pridať ${contact.name} medzi obľúbené` }).click();
  await expect(option.getByRole("button", { name: `Odobrať ${contact.name} z obľúbených` })).toBeVisible();
  await option.locator("button").first().click();
  await phonePanel.getByRole("button", { name: "Volať", exact: true }).click();

  // No telephony provider is configured in this build: dialling must not hit
  // any API and the phone panel explains why instead.
  await expect(phonePanel.getByRole("alert").filter({ hasText: "Telefónia nie je nakonfigurovaná" })).toBeVisible();
});

test("selecting another case keeps a dirty new card open without a popup", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await openDashboard(page);
  await openNewCase(page);

  const plate = page.getByLabel("EČV", { exact: true });
  await plate.fill("DIRTY E2E");
  let dialogCount = 0;
  page.on("dialog", async (dialog) => {
    dialogCount += 1;
    await dialog.dismiss();
  });
  await page.getByRole("button").filter({ hasText: "PM-2026-0516" }).first().click();

  await expect(plate).toHaveValue("DIRTY E2E");
  expect(dialogCount).toBe(0);
  await expect(page.getByRole("heading", { name: "1. Základ prípadu", exact: true })).toBeVisible();
});

test("invalid edit stays protected without a popup and can be explicitly discarded", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await openCaseEdit(page);
  await page.getByRole("textbox", { name: /^VIN/ }).fill("INVALID");

  let dialogCount = 0;
  page.on("dialog", async (dialog) => {
    dialogCount += 1;
    await dialog.dismiss();
  });
  await expect(page.getByRole("button", { name: "Zavrieť editáciu", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Zbaliť workspace", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Zahodiť zmeny", exact: true }).click();
  await expect(page.getByTestId("case-edit-form-main")).toBeVisible();
  await expect(page.getByRole("textbox", { name: /^VIN/ })).not.toHaveValue("INVALID");
  await expect(page.getByRole("status")).toContainText("Rozpracované zmeny boli zahodené");
  expect(dialogCount).toBe(0);
});

test("warning banner does not block case editing on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: viewportHeight });
  await openCaseEdit(page);

  const warning = page.getByRole("alert").filter({ hasText: "Supabase server env nie je nastavený" });
  const editor = page.getByTestId("case-edit-form-main");
  const workspacePanel = page.locator('.dispatch-workspace-panel[data-workspace-mode="expanded"]');
  await expect(editor).toBeVisible();
  await expect(page.getByText("Postup karty", { exact: true })).toHaveCount(0);
  if (await warning.isVisible()) {
    const warningBox = await warning.boundingBox();
    const workspacePanelBox = await workspacePanel.boundingBox();
    expect(warningBox).not.toBeNull();
    expect(workspacePanelBox).not.toBeNull();
    expect(warningBox!.y + warningBox!.height).toBeLessThanOrEqual(workspacePanelBox!.y + 1);
  }
  await expectNoDocumentOverflow(page, "mobile case edit", "[data-case-detail-scroll-region]");
});

test("case edit uses the full content width without workflow or sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await openCaseEdit(page);

  await expect(page.getByText("Postup karty", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Kontrola karty", exact: true })).toHaveCount(0);
  await expect(page.locator("[data-form-section-state='valid']")).toHaveCount(5);
  await expectEditFormUsesFullWidth(page, "desktop case edit");
});

test("case edit rejects invalid VIN characters before they reach form state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await openCaseEdit(page);
  const unusualText = `\"><img src=x onerror="window.__ultraqaXss=1"> ŽA-42 \u202E TEST`;
  const vin = page.getByRole("textbox", { name: /^VIN/ });

  await vin.fill(unusualText);

  await expect(vin).toHaveValue(/^[A-HJ-NPR-Z0-9]{0,17}$/);
  await expect(vin).not.toHaveValue(unusualText);
  expect(await page.evaluate(() => Boolean((window as typeof window & { __ultraqaXss?: boolean }).__ultraqaXss))).toBe(false);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(page.getByTestId("case-edit-form-main")).toBeVisible();
});

test("pending autosave keeps navigation available and explains the safe choices", async ({ page }) => {
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });

  await speedUpAutosave(page);
  await page.route("**/api/cases/*", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }

    await responseGate;
    await route.fulfill({ status: 409, json: { error: "Dočasná kolízia. Skúste to znova." } });
  });

  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await openCaseEdit(page);
  const plate = page.getByLabel("EČV", { exact: true });
  await plate.fill("RETRY EDIT");

  await expect(page.getByTestId("case-autosave-status")).toContainText("Ukladám automaticky");
  await expect(page.getByRole("button", { name: "Uložiť", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Zrušiť", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Zavrieť editáciu", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Späť", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Zbaliť workspace", exact: true })).toHaveCount(0);
  const mainNavigation = page.getByRole("navigation", { name: "Hlavná navigácia" });
  await mainNavigation.getByRole("button", { name: "Menu", exact: true }).click();
  const tasksNavigation = mainNavigation.getByRole("menuitem", { name: /Úlohy/ });
  await expect(tasksNavigation).toBeEnabled();
  await expect(page.getByRole("button", { name: "Nový prípad", exact: true })).toBeEnabled();
  await expect(plate).toBeEnabled();
  await tasksNavigation.click();
  await expect(page.getByRole("dialog")).toContainText("Na karte sú neuložené zmeny");
  await expect(page.getByRole("button", { name: "Odísť bez uloženia", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Zostať vo formulári", exact: true }).first().click();
  releaseResponse();

  await expect(page.getByRole("alert").filter({ hasText: "Dočasná kolízia." })).toBeVisible();
  await expect(plate).toHaveValue("RETRY EDIT");
  await expect(page.getByRole("button", { name: "Skúsiť znova", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Späť", exact: true })).toBeEnabled();
});

test("valid edits save automatically and refresh the open card", async ({ page }) => {
  let patchCount = 0;
  let submittedPlate = "";
  const submittedDriveableValues: Array<boolean | undefined> = [];
  let savedCaseId = "";

  await speedUpAutosave(page);
  await page.route("**/api/cases/*", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }

    patchCount += 1;
    const payload = route.request().postDataJSON() as { licensePlate?: string; vehicleDriveable?: boolean };
    submittedPlate = payload.licensePlate ?? "";
    submittedDriveableValues.push(payload.vehicleDriveable);
    savedCaseId = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
    const dispatchData = createMockDispatchData({
      dispatchCases: mockDispatchCases.map((caseItem) =>
        caseItem.id === savedCaseId
          ? { ...caseItem, vehicle: { ...caseItem.vehicle, licensePlate: submittedPlate }, updatedAt: new Date().toISOString() }
          : caseItem,
      ),
    });
    await route.fulfill({ status: 200, json: { caseId: savedCaseId, dispatchData, warnings: [] } });
  });

  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await openCaseEdit(page);
  await page.getByLabel("EČV", { exact: true }).fill("QA SAVE 42");
  await page.getByRole("button", { name: "Pojazdné", exact: true }).click();

  await expect(page.getByTestId("case-autosave-status")).toContainText("Uložené automaticky");
  await expect(page.getByTestId("case-edit-form-main")).toBeVisible();
  await expect.poll(() => patchCount).toBe(1);
  expect(submittedPlate).toBe("QA SAVE 42");
  expect(submittedDriveableValues).toEqual([true]);

  // A button-only change must create its own save; no typing event is involved.
  await page.getByRole("button", { name: "Nepojazdné", exact: true }).click();
  await expect.poll(() => patchCount).toBe(2);
  await expect(page.getByTestId("case-autosave-status")).toContainText("Uložené automaticky");
  expect(submittedDriveableValues).toEqual([true, false]);

  await page.getByRole("button", { name: "Späť", exact: true }).click();
  await expect(page.getByTestId("case-edit-form-main")).toBeVisible();
  await expect(page.getByLabel("EČV", { exact: true })).toHaveValue("QA SAVE 42");
});

test("a committed edit with a failed refresh reconciles without a duplicate PATCH", async ({ page }) => {
  let patchCount = 0;
  let refreshCount = 0;
  let submittedPlate = "";
  let savedCaseId = "";

  await speedUpAutosave(page);
  await page.route("**/api/cases/*", async (route) => {
    if (route.request().method() === "GET") {
      refreshCount += 1;
      if (refreshCount === 1) {
        await route.fulfill({ status: 503, json: { error: "Dočasne sa nedá overiť aktuálny stav." } });
      } else {
        const dispatchData = createMockDispatchData({
          dispatchCases: mockDispatchCases.map((caseItem) =>
            caseItem.id === savedCaseId
              ? { ...caseItem, vehicle: { ...caseItem.vehicle, licensePlate: submittedPlate }, updatedAt: new Date().toISOString() }
              : caseItem,
          ),
        });
        await route.fulfill({ status: 200, json: { dispatchData } });
      }
      return;
    }

    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }

    patchCount += 1;
    const payload = route.request().postDataJSON() as { licensePlate?: string };
    submittedPlate = payload.licensePlate ?? "";
    savedCaseId = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
    await route.fulfill({ status: 200, json: { caseId: savedCaseId, refreshRequired: true, warnings: [] } });
  });

  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await openCaseEdit(page);
  const plate = page.getByLabel("EČV", { exact: true });
  await plate.fill("REFRESH RETRY");

  await expect(page.getByRole("alert").filter({ hasText: "Zmena bola prijatá serverom" })).toBeVisible();
  await expect(plate).toHaveValue("REFRESH RETRY");
  await expect(page.getByRole("button", { name: "Overiť uložený stav", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Späť", exact: true })).toBeEnabled();
  await expect(plate).toBeEnabled();
  await page.getByRole("button", { name: "Overiť uložený stav", exact: true }).click();

  await expect(page.getByTestId("case-autosave-status")).toContainText("Uložené automaticky");
  expect(patchCount).toBe(1);
  expect(refreshCount).toBe(2);
});

test("autosave retries transient server failures and keeps the latest edit", async ({ page }) => {
  let patchCount = 0;
  let submittedPlate = "";

  await speedUpAutosave(page, { retries: true });
  await page.route("**/api/cases/*", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }

    patchCount += 1;
    const payload = route.request().postDataJSON() as { licensePlate?: string };
    submittedPlate = payload.licensePlate ?? "";
    if (patchCount < 3) {
      await route.fulfill({ status: 502, json: { error: "Dočasná chyba brány." } });
      return;
    }

    const caseId = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
    const dispatchData = createMockDispatchData({
      dispatchCases: mockDispatchCases.map((caseItem) =>
        caseItem.id === caseId
          ? { ...caseItem, vehicle: { ...caseItem.vehicle, licensePlate: submittedPlate }, updatedAt: new Date().toISOString() }
          : caseItem,
      ),
    });
    await route.fulfill({ status: 200, json: { caseId, dispatchData, warnings: [] } });
  });

  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await openCaseEdit(page);
  await page.getByLabel("EČV", { exact: true }).fill("LATEST RETRY");

  await expect(page.getByTestId("case-autosave-status")).toContainText("Uložené automaticky");
  expect(patchCount).toBe(3);
  expect(submittedPlate).toBe("LATEST RETRY");
});

test("slow autosave leaves navigation available while the server responds", async ({ page }) => {
  await speedUpAutosave(page, { slowNotice: true });
  await page.route("**/api/cases/*", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ status: 409, json: { error: "Neskorá odpoveď." } }).catch(() => undefined);
  });

  await page.setViewportSize({ width: 1280, height: viewportHeight });
  await openCaseEdit(page);
  const plate = page.getByLabel("EČV", { exact: true });
  await plate.fill("TIMEOUT EDIT");

  await expect(page.getByRole("status").filter({ hasText: "Automatické ukladanie stále prebieha." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Uložiť", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Späť", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Zbaliť workspace", exact: true })).toHaveCount(0);
  await expect(plate).toBeEnabled();
  await expect(page.getByRole("alert").filter({ hasText: "Neskorá odpoveď." })).toBeVisible();
  await expect(plate).toHaveValue("TIMEOUT EDIT");
  await expect(page.getByRole("button", { name: "Skúsiť znova", exact: true })).toBeVisible();
});

async function openDashboard(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const loginHeading = page.getByRole("heading", { name: "Prihlásenie", exact: true });
  const dashboardHeading = page.getByTestId("dispatch-console");

  await expect(loginHeading.or(dashboardHeading)).toBeVisible({ timeout: 30_000 });

  if (await loginHeading.isVisible()) {
    const email = process.env.E2E_EMAIL?.trim();
    const password = process.env.E2E_PASSWORD;
    test.skip(!email || !password, "Dashboard smoke requires E2E_EMAIL and E2E_PASSWORD when the development auth bypass is disabled.");

    await page.getByLabel("Email", { exact: true }).fill(email!);
    await page.getByLabel("Heslo", { exact: true }).fill(password!);
    await page.getByRole("button", { name: "Prihlásiť sa", exact: true }).click();
  }

  await expect(dashboardHeading).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true", { timeout: 30_000 });
}

function createMockDispatchData(overrides: Partial<DispatchData> = {}): DispatchData {
  const now = new Date().toISOString();

  return {
    attendance: mockAttendance,
    users: mockOperators.map((operator) => ({
      id: operator.id,
      name: operator.name,
      role: "dispatcher",
      extension: operator.extension,
      active: true,
      accessStatus: "not_invited",
      createdAt: now,
      updatedAt: now,
    })),
    operators: mockOperators,
    branches: mockBranches,
    partnerDirectory: [],
    fleetAssets: mockFleetAssets,
    fleetProviderVehicles: [],
    commanderVehicles: [],
    priceRules: mockPriceRules,
    incomingCall: mockIncomingCall,
    callCenterCalls: mockCallCenterCalls,
    dispatchCases: mockDispatchCases,
    notifications: mockNotifications,
    metrics: mockMetrics,
    integrations: mockIntegrations,
    source: "supabase",
    ...overrides,
  };
}

async function openNewCase(page: Page) {
  const newCaseButtons = page.getByRole("button", { name: "Nový prípad", exact: true });

  for (let index = 0; index < (await newCaseButtons.count()); index += 1) {
    const button = newCaseButtons.nth(index);
    if (await button.isVisible()) {
      await button.click();
      return;
    }
  }

  const menuButtons = page.getByRole("button", { name: "Menu", exact: true });
  for (let index = 0; index < (await menuButtons.count()); index += 1) {
    const button = menuButtons.nth(index);
    if (await button.isVisible()) {
      await button.click();
      break;
    }
  }

  const casesTab = page.getByRole("menuitem", { name: "Prípady", exact: true });
  await expect(casesTab).toBeVisible();
  await casesTab.click();

  const directoryNewCase = page.getByRole("button", { name: "Nový prípad", exact: true });
  await expect(directoryNewCase).toBeVisible();
  await directoryNewCase.click();
}

async function openCaseEdit(page: Page) {
  await openDashboard(page);
  await page.getByRole("button", { name: /^Detail prípadu / }).first().click();
  await expect(page.getByTestId("case-edit-form-main")).toBeVisible();
}

async function speedUpAutosave(
  page: Page,
  options: { retries?: boolean; slowNotice?: boolean } = {},
) {
  await page.addInitScript(({ retries, slowNotice }) => {
    const originalSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      let adjustedTimeout = timeout;
      if (timeout === 1_200) adjustedTimeout = 250;
      if (retries && (timeout === 1_500 || timeout === 5_000)) adjustedTimeout = 20;
      if (slowNotice && timeout === 8_000) adjustedTimeout = 50;
      return originalSetTimeout(handler, adjustedTimeout, ...args);
    }) as typeof window.setTimeout;
  }, options);
}

async function expectNoDocumentOverflow(page: Page, context: string, scopeSelector?: string) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const documentElement = document.documentElement;
          return documentElement.scrollWidth - documentElement.clientWidth;
        }),
      { message: `${context} must not scroll horizontally`, timeout: 15_000 },
    )
    .toBeLessThanOrEqual(1);

  const overflow = await page.evaluate(({ scopeSelector }) => {
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const scope = scopeSelector ? document.querySelector<HTMLElement>(scopeSelector) : null;
    const isRendered = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < viewportHeight &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        !element.closest("[inert], [aria-hidden='true'], .gm-style")
      );
    };
    const isInsideIntentionalScroller = (element: HTMLElement) => {
      let ancestor = element.parentElement;

      while (ancestor) {
        const overflowX = window.getComputedStyle(ancestor).overflowX;
        if ((overflowX === "auto" || overflowX === "scroll") && ancestor.scrollWidth > ancestor.clientWidth + 1) {
          return true;
        }
        ancestor = ancestor.parentElement;
      }

      return false;
    };
    const offenders = Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return isRendered(element) && !isInsideIntentionalScroller(element) && (rect.left < -1 || rect.right > viewportWidth + 1);
      })
      .slice(0, 8)
      .map((element) => ({
        className: element.className?.toString().slice(0, 160) || undefined,
        left: Math.round(element.getBoundingClientRect().left),
        right: Math.round(element.getBoundingClientRect().right),
        tag: element.tagName.toLowerCase(),
      }));
    const clippedOffenders = scope
      ? Array.from(scope.querySelectorAll<HTMLElement>("*"))
          .filter((element) => {
            if (!isRendered(element) || element.clientWidth <= 0 || element.scrollWidth <= element.clientWidth + 1) {
              return false;
            }

            const style = window.getComputedStyle(element);
            return (
              style.overflowX !== "auto" &&
              style.overflowX !== "scroll" &&
              style.textOverflow !== "ellipsis" &&
              !element.matches("input, select, textarea")
            );
          })
          .slice(0, 8)
          .map((element) => ({
            className: element.className?.toString().slice(0, 160) || undefined,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            tag: element.tagName.toLowerCase(),
          }))
      : [];

    return {
      clientWidth: viewportWidth,
      clippedOffenders,
      offenders,
      scrollWidth: document.documentElement.scrollWidth,
    };
  }, { scopeSelector });

  expect(overflow.scrollWidth, `${context}: ${JSON.stringify(overflow.offenders)}`).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.offenders, `${context} has elements outside the viewport`).toEqual([]);
  expect(overflow.clippedOffenders, `${context} has clipped horizontal content`).toEqual([]);
}

async function expectNoElementOverflow(locator: Locator, context: string) {
  await expect(locator).toBeVisible();
  await expect
    .poll(() => locator.evaluate((element) => element.scrollWidth - element.clientWidth), {
      message: `${context} must not clip horizontal content`,
    })
    .toBeLessThanOrEqual(1);
}

async function expectCaseFormUsesFullWidth(page: Page, context: string) {
  const measurements = await page.evaluate(() => {
    const scrollRegion = document.querySelector<HTMLElement>("[data-testid='case-form-scroll-region']");
    const main = document.querySelector<HTMLElement>("[data-testid='case-form-main']")?.getBoundingClientRect();
    const asideCount = document.querySelectorAll("[data-testid='case-form-aside']").length;

    if (!scrollRegion || !main) {
      return null;
    }

    const scroll = scrollRegion.getBoundingClientRect();
    const styles = getComputedStyle(scrollRegion);
    const contentLeft = scroll.left + Number.parseFloat(styles.paddingLeft);
    const contentRight = scroll.right - Number.parseFloat(styles.paddingRight);

    return {
      asideCount,
      mainLeftGap: Math.abs(main.left - contentLeft),
      mainRightGap: Math.abs(contentRight - main.right),
    };
  });

  expect(measurements, `${context} must render the form`).not.toBeNull();
  expect(measurements?.asideCount, `${context} must not render the old sidebar`).toBe(0);
  expect(measurements?.mainLeftGap, `${context} main form left edge`).toBeLessThanOrEqual(1);
  expect(measurements?.mainRightGap, `${context} main form right edge`).toBeLessThanOrEqual(1);
}

async function expectEditFormUsesFullWidth(page: Page, context: string) {
  const measurements = await page.evaluate(() => {
    const statusElement = document.querySelector<HTMLElement>("[data-testid='case-autosave-status']");
    const mainElement = document.querySelector<HTMLElement>("[data-testid='case-edit-form-main']");
    const editRoot = statusElement?.parentElement;

    if (!statusElement || !mainElement || !editRoot) {
      return null;
    }

    const status = statusElement.getBoundingClientRect();
    const main = mainElement.getBoundingClientRect();

    return {
      asideCount: editRoot.querySelectorAll("aside").length,
      leftGap: Math.abs(status.left - main.left),
      rightGap: Math.abs(status.right - main.right),
    };
  });

  expect(measurements, `${context} must render the edit form and autosave status`).not.toBeNull();
  expect(measurements?.asideCount, `${context} must not render the old sidebar`).toBe(0);
  expect(measurements?.leftGap, `${context} left edges`).toBeLessThanOrEqual(1);
  expect(measurements?.rightGap, `${context} right edges`).toBeLessThanOrEqual(1);
}
