import { expect, test, type Page, type Route } from "@playwright/test";
import type { CallCenterCall } from "@/data/dispatch-types";

test.describe.configure({ mode: "serial" });

const callId = "123e4567-e89b-42d3-a456-426614174000";
const checkedAt = new Date().toISOString();

test("manager controls fail closed and show only reloaded routing state", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const unexpectedRequests: string[] = [];
  const assignmentBodies: unknown[] = [];
  const priorityBodies: unknown[] = [];
  let allowFirstRoutingResponse!: () => void;
  let allowAssignmentFailure!: () => void;
  let allowPostApplyReload!: () => void;
  const firstRoutingResponse = new Promise<void>((resolve) => { allowFirstRoutingResponse = resolve; });
  const assignmentFailure = new Promise<void>((resolve) => { allowAssignmentFailure = resolve; });
  const postApplyReload = new Promise<void>((resolve) => { allowPostApplyReload = resolve; });
  let routingReads = 0;
  let gateEnabled = false;
  let waitingForPostApplyReload = false;

  await installApiFirewall(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/api/telephony/extension-assignments") {
      if (method === "GET") return fulfillJson(route, { ok: true, extensions: extensionAssignments() });
      if (method === "PATCH") {
        assignmentBodies.push(request.postDataJSON());
        await assignmentFailure;
        return fulfillJson(route, { error: "Simulovaný konflikt vlastníka." }, 409);
      }
    }

    if (url.pathname === "/api/telephony/routing/priority") {
      if (method === "GET") {
        routingReads += 1;
        if (routingReads === 1) {
          await firstRoutingResponse;
          return fulfillJson(route, { error: "Simulovaný výpadok načítania." }, 503);
        }
        if (waitingForPostApplyReload) {
          await postApplyReload;
          waitingForPostApplyReload = false;
          return fulfillJson(route, { ok: true, routing: routingSnapshot(true, "degraded") });
        }
        return fulfillJson(route, { ok: true, routing: routingSnapshot(gateEnabled) });
      }
      if (method === "POST") {
        const body = request.postDataJSON() as { action?: string; dryRun?: boolean };
        priorityBodies.push(body);
        if (body.action === "apply" && body.dryRun !== false) {
          return fulfillJson(route, {
            ok: true,
            preview: {
              steps: [
                { action: "add", queue: "601", extension: "21" },
                { action: "remove", queue: "601", extension: "20" },
                { action: "add", queue: "602", extension: "20" },
                { action: "remove", queue: "602", extension: "21" },
              ],
              targetRevision: 8,
            },
            previewDigest: "a".repeat(64),
          });
        }
        if (body.action === "apply" && body.dryRun === false) {
          waitingForPostApplyReload = true;
          return fulfillJson(route, { ok: true });
        }
      }
    }

    return fulfillCommonTelephonyRoute(route, unexpectedRequests);
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await openDashboard(page);
  await page.getByRole("button", { name: "Nastavenia", exact: true }).click();
  await page.getByRole("button", { name: "Telefonovanie", exact: true }).click();

  await expect(page.getByText("Načítavam poradie zvonenia…", { exact: true })).toBeVisible();
  allowFirstRoutingResponse();
  await expect(page.getByText("Poradie volania sa nepodarilo načítať.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Skúsiť znova", exact: true }).click();
  await expect(page.getByText("Ukladanie zmien momentálne nie je dostupné", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Uložiť poradie volania", exact: true })).toBeDisabled();

  const firstQueue = page.getByRole("combobox", { name: "1. volaný operátor – rad 601", exact: true });
  const secondQueue = page.getByRole("combobox", { name: "2. volaný operátor – rad 602", exact: true });
  const fallbackSelect = page.getByRole("combobox", { name: "Záložný operátor počas zmeny" });
  await firstQueue.selectOption("");
  await expect(secondQueue.locator('option[value="20"]')).toBeEnabled();
  await secondQueue.selectOption("20");
  await expect(firstQueue.locator('option[value="21"]')).toBeEnabled();
  await firstQueue.selectOption("21");
  await fallbackSelect.selectOption("603:22");

  const extension23 = page.getByText("Klapka 23", { exact: true }).locator("xpath=ancestor::div[contains(@class,'grid items-start')]");
  const ownerSelect = page.getByRole("combobox", { name: "Operátor pre klapku 23", exact: true });
  await ownerSelect.selectOption("op-lenka");
  await extension23.getByRole("textbox", { name: "Potvrdenie zmeny SIP prístupu", exact: true }).fill("QA-ROTATION-23");
  await extension23.getByRole("checkbox", { name: /prihlasovacie údaje klapky boli vo VIPTel bezpečne zmenené/ }).check();
  await extension23.getByRole("button", { name: "Uložiť priradenie", exact: true }).click();
  await expect(ownerSelect).toBeDisabled();
  gateEnabled = true;
  allowAssignmentFailure();
  await expect(page.getByText("Simulovaný konflikt vlastníka.", { exact: true })).toBeVisible();
  await expect(ownerSelect).toHaveValue("");
  expect(assignmentBodies).toEqual([
    expect.objectContaining({ extensionId: "ext-23", profileId: "op-lenka", rotationAttested: true }),
  ]);

  await expect(page.getByText("Ukladanie zmien je pripravené", { exact: true })).toBeVisible();
  await expect(firstQueue).toHaveValue("21");
  await expect(secondQueue).toHaveValue("20");
  await expect(fallbackSelect).toHaveValue("603:22");

  const dryRun = page.getByRole("button", { name: "Skontrolovať zmenu", exact: true });
  await dryRun.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Overené pre verziu 7 → 8 · 4 krokov/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Uložiť poradie volania", exact: true })).toBeEnabled();

  await page.getByText("Technické informácie o verzii nastavenia", { exact: true }).click();
  await page.getByRole("button", { name: "Uložiť poradie volania", exact: true }).click();
  await expect(page.getByText(/Server požiadavku prijal.*nie optimistický výsledok/)).toBeVisible();
  await expect(page.getByText(/Aktuálna verzia poradia: 7\./)).toBeVisible();
  await expect(page.getByText(/Aktuálna verzia poradia: 8\./)).toHaveCount(0);
  allowPostApplyReload();
  await expect(page.getByText("Zmena je zastavená a vyžaduje zásah", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Zosúladiť stav", exact: true })).toBeVisible();

  expect(priorityBodies).toHaveLength(2);
  expect(unexpectedRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await expectNoDocumentOverflow(page);
});

test("routing refreshes preserve a draft and ignore an older response", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const unexpectedRequests: string[] = [];
  let routingReads = 0;
  let olderResponseCompleted = false;
  let allowOlderResponse!: () => void;
  let markOlderRequestStarted!: () => void;
  const olderResponse = new Promise<void>((resolve) => { allowOlderResponse = resolve; });
  const olderRequestStarted = new Promise<void>((resolve) => { markOlderRequestStarted = resolve; });

  await installApiFirewall(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/api/telephony/extension-assignments" && method === "GET") {
      return fulfillJson(route, { ok: true, extensions: extensionAssignments() });
    }
    if (url.pathname === "/api/telephony/routing/priority" && method === "GET") {
      routingReads += 1;
      if (routingReads === 1) {
        return fulfillJson(route, { ok: true, routing: routingSnapshot(true) });
      }
      if (routingReads === 2) {
        markOlderRequestStarted();
        await olderResponse;
        const fulfilled = await fulfillJson(route, {
          ok: true,
          routing: { ...routingSnapshot(false), revision: 6 },
        });
        olderResponseCompleted = true;
        return fulfilled;
      }
      const newestRouting = routingSnapshot(true);
      return fulfillJson(route, {
        ok: true,
        routing: {
          ...newestRouting,
          revision: 8,
          actualMemberships: newestRouting.actualMemberships.filter(
            (membership) => !(membership.queue === "603" && membership.extension === "22"),
          ),
        },
      });
    }

    return fulfillCommonTelephonyRoute(route, unexpectedRequests);
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await openDashboard(page);
  await page.getByRole("button", { name: "Nastavenia", exact: true }).click();
  await page.getByRole("button", { name: "Telefonovanie", exact: true }).click();

  const firstQueue = page.getByRole("combobox", { name: "1. volaný operátor – rad 601", exact: true });
  const secondQueue = page.getByRole("combobox", { name: "2. volaný operátor – rad 602", exact: true });
  const fallbackSelect = page.getByRole("combobox", { name: "Záložný operátor počas zmeny" });
  await firstQueue.selectOption("");
  await expect(secondQueue.locator('option[value="20"]')).toBeEnabled();
  await secondQueue.selectOption("20");
  await expect(firstQueue.locator('option[value="21"]')).toBeEnabled();
  await firstQueue.selectOption("21");
  await fallbackSelect.selectOption("603:22");

  const refreshRouting = page.getByRole("button", { name: "Obnoviť poradie", exact: true });
  await refreshRouting.click();
  await olderRequestStarted;
  await refreshRouting.click();
  await expect.poll(() => routingReads).toBe(3);

  await page.getByText("Technické informácie o verzii nastavenia", { exact: true }).click();
  await expect(page.getByText(/Aktuálna verzia poradia: 8\./)).toBeVisible();
  await expect(firstQueue).toHaveValue("21");
  await expect(secondQueue).toHaveValue("20");
  await expect(fallbackSelect).toHaveValue("603:22");
  await expect(fallbackSelect.locator('option[value="603:22"]')).toHaveAttribute("disabled", "");
  await expect(page.getByText("Vybraný záložný operátor už nie je dostupný. Vyberte iného.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Skontrolovať zmenu", exact: true })).toBeDisabled();

  allowOlderResponse();
  await expect.poll(() => olderResponseCompleted).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(page.getByText(/Aktuálna verzia poradia: 8\./)).toBeVisible();
  await expect(page.getByText(/Aktuálna verzia poradia: 6\./)).toHaveCount(0);
  await expect(page.getByText("Ukladanie zmien je pripravené", { exact: true })).toBeVisible();
  await expect(firstQueue).toHaveValue("21");
  await expect(secondQueue).toHaveValue("20");
  await expect(fallbackSelect).toHaveValue("603:22");
  await expect(fallbackSelect.locator('option[value="603:22"]')).toHaveAttribute("disabled", "");

  expect(unexpectedRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await expectNoDocumentOverflow(page);
});

test("readiness uses the confirmed plan and blocks while a routing change is unfinished", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const unexpectedRequests: string[] = [];
  let operationActive = false;

  await installApiFirewall(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/api/telephony/extension-assignments" && method === "GET") {
      return fulfillJson(route, { ok: true, extensions: fullyAssignedExtensions() });
    }
    if (url.pathname === "/api/telephony/routing/priority" && method === "GET") {
      return fulfillJson(route, {
        ok: true,
        routing: routingSnapshot(true, operationActive ? "degraded" : undefined),
      });
    }
    if (url.pathname === "/api/telephony/routing/lines" && method === "GET") {
      return fulfillJson(route, {
        ok: true,
        gate: { enabled: true, reason: "enabled" },
        plan: readyViptelLinePlan(),
      });
    }

    return fulfillCommonTelephonyRoute(route, unexpectedRequests);
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await openDashboard(page);
  await page.getByRole("button", { name: "Nastavenia", exact: true }).click();
  await page.getByRole("button", { name: "Telefonovanie", exact: true }).click();

  await expect(page.getByText("4 z 4 priradených", { exact: true })).toBeVisible();
  await expect(page.getByText("3 z 3 miest nastavených", { exact: true })).toBeVisible();
  await expect(page.getByText("9 čísel – postačuje", { exact: true })).toBeVisible();
  await expect(page.getByText("Pripravené na testovací hovor", { exact: true })).toBeVisible();

  operationActive = true;
  await page.getByRole("button", { name: "Obnoviť poradie", exact: true }).click();
  await expect(page.getByText("Prebieha alebo čaká nedokončená zmena", { exact: true })).toBeVisible();
  await expect(page.getByText("Ešte nie je pripravené na test", { exact: true })).toBeVisible();
  await expect(page.getByText("Pripravené na testovací hovor", { exact: true })).toHaveCount(0);

  const reconcile = page.getByRole("button", { name: "Zosúladiť stav", exact: true });
  await expect(reconcile).toHaveAccessibleDescription(/Obnovu, pokračovanie alebo návrat.*Každý zápis sa ešte overí serverom/);
  expect(unexpectedRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await expectNoDocumentOverflow(page);
});

test("manager reviews and starts the explicit completely-empty routing bootstrap", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const unexpectedRequests: string[] = [];
  const priorityBodies: Array<Record<string, unknown>> = [];
  let bootstrapStarted = false;

  await installApiFirewall(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/api/telephony/extension-assignments" && method === "GET") {
      return fulfillJson(route, { ok: true, extensions: extensionAssignments() });
    }
    if (url.pathname === "/api/telephony/routing/priority") {
      if (method === "GET") {
        return fulfillJson(route, { ok: true, routing: emptyRoutingSnapshot(bootstrapStarted) });
      }
      if (method === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        priorityBodies.push(body);
        if (body.action === "bootstrap-empty" && body.dryRun !== false) {
          return fulfillJson(route, {
            ok: true,
            preview: {
              targetRevision: 1,
              steps: [
                { action: "add", queue: "603", extension: "22" },
                { action: "add", queue: "602", extension: "21" },
                { action: "add", queue: "601", extension: "20" },
              ],
            },
            previewDigest: "b".repeat(64),
          });
        }
        if (body.action === "bootstrap-empty" && body.dryRun === false) {
          bootstrapStarted = true;
          return fulfillJson(route, { ok: true });
        }
      }
    }

    return fulfillCommonTelephonyRoute(route, unexpectedRequests);
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await openDashboard(page);
  await page.getByRole("button", { name: "Nastavenia", exact: true }).click();
  await page.getByRole("button", { name: "Telefonovanie", exact: true }).click();
  await expect(page.getByText("Prvé nastavenie poradia", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Záložný operátor počas zmeny" })).toHaveCount(0);

  await page.getByRole("combobox", { name: "1. volaný operátor – rad 601", exact: true }).selectOption("20");
  await page.getByRole("combobox", { name: "2. volaný operátor – rad 602", exact: true }).selectOption("21");
  await page.getByRole("combobox", { name: "3. volaný operátor – rad 603", exact: true }).selectOption("22");

  const verify = page.getByRole("button", { name: "Skontrolovať prvé nastavenie", exact: true });
  await verify.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("1. pridať · rad 603 · klapka 22", { exact: true })).toBeVisible();
  await expect(page.getByText("2. pridať · rad 602 · klapka 21", { exact: true })).toBeVisible();
  await expect(page.getByText("3. pridať · rad 601 · klapka 20", { exact: true })).toBeVisible();

  const start = page.getByRole("button", { name: "Spustiť prvé nastavenie", exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByText(/Prvé nastavenie poradia:/)).toBeVisible();

  expect(priorityBodies).toEqual([
    {
      action: "bootstrap-empty",
      dryRun: true,
      baseRevision: 0,
      slots: [
        { queue: "601", extension: "20" },
        { queue: "602", extension: "21" },
        { queue: "603", extension: "22" },
      ],
    },
    {
      action: "bootstrap-empty",
      dryRun: false,
      baseRevision: 0,
      slots: [
        { queue: "601", extension: "20" },
        { queue: "602", extension: "21" },
        { queue: "603", extension: "22" },
      ],
      previewDigest: "b".repeat(64),
    },
  ]);
  expect(unexpectedRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await expectNoDocumentOverflow(page);
});

test("an empty operator setup explains the next step and refreshes routing after an explicit assignment", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const unexpectedRequests: string[] = [];
  const assignmentBodies: unknown[] = [];
  let assigned = false;
  let routingReads = 0;

  await installApiFirewall(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/api/telephony/extension-assignments") {
      if (method === "GET") {
        return fulfillJson(route, { ok: true, extensions: initiallyUnassignedExtensions(assigned) });
      }
      if (method === "PATCH") {
        assignmentBodies.push(request.postDataJSON());
        assigned = true;
        return fulfillJson(route, { ok: true });
      }
    }

    if (url.pathname === "/api/telephony/routing/priority" && method === "GET") {
      routingReads += 1;
      return fulfillJson(route, { ok: true, routing: routingAfterFirstAssignment(assigned) });
    }

    if (url.pathname === "/api/telephony/presence" && (method === "GET" || method === "POST")) {
      return fulfillJson(route, {
        ok: true,
        source: method === "POST" ? "provider_refresh" : "stored",
        actorRouting: null,
        routingDiagnostic: "Prihlásený operátor ešte nie je v poradí 601–603.",
        snapshot: presenceSnapshotForExtensions(initiallyUnassignedExtensions(assigned), new Date().toISOString()),
      });
    }

    return fulfillCommonTelephonyRoute(route, unexpectedRequests);
  });

  await page.setViewportSize({ width: 1280, height: 1000 });
  await openDashboard(page);
  await page.evaluate(() => {
    (window as typeof window & { __viptelAssignmentMarker?: string }).__viptelAssignmentMarker = "same-page";
  });
  await page.getByRole("button", { name: "Nastavenia", exact: true }).click();
  await page.getByRole("button", { name: "Telefonovanie", exact: true }).click();

  await expect(page.getByText("Ešte nie je pripravené na test", { exact: true })).toBeVisible();
  await expect(page.getByText("0 z 4 priradených", { exact: true })).toBeVisible();
  await expect(page.getByText("0 z 3 miest nastavených", { exact: true })).toBeVisible();
  await expect(page.getByText("Zatiaľ nie je koho zaradiť do poradia.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Najprv priraďte aspoň troch operátorov ku klapkám 20–23/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Prejsť na operátorov", exact: true })).toHaveAttribute("href", "#viptel-operators");

  const ownerSelect = page.getByRole("combobox", { name: "Operátor pre klapku 20", exact: true });
  await expect(ownerSelect).toBeEnabled();
  await ownerSelect.selectOption("op-natalia");
  const initialConfirmation = page.getByRole("checkbox", {
    name: "Potvrdzujem prvé pridelenie tejto doteraz nepoužitej klapky.",
    exact: true,
  });
  await initialConfirmation.check();
  const saveAssignment = page.getByRole("button", { name: "Uložiť priradenie", exact: true });
  await expect(saveAssignment).toBeEnabled();
  await saveAssignment.click();

  await expect(page.getByText(/Operátor bol priradený ku klapke 20/)).toBeVisible();
  await expect(page.getByText("1 z 4 priradených", { exact: true })).toBeVisible();
  const firstQueue = page.getByRole("combobox", { name: "1. volaný operátor – rad 601", exact: true });
  await expect(firstQueue.locator("option", { hasText: "Natália · klapka 20" })).toHaveCount(1);
  await firstQueue.selectOption("20");
  await expect(firstQueue).toHaveValue("20");
  expect(routingReads).toBeGreaterThanOrEqual(2);
  expect(assignmentBodies).toEqual([
    {
      extensionId: "ext-20",
      profileId: "op-natalia",
      initialProvisioningAttested: true,
    },
  ]);
  await expect.poll(() => page.evaluate(
    () => (window as typeof window & { __viptelAssignmentMarker?: string }).__viptelAssignmentMarker,
  )).toBe("same-page");
  expect(unexpectedRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await expectNoDocumentOverflow(page);
});

test("a stale stored presence keeps owner drafts usable across a fresh refresh and an older poll", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const unexpectedRequests: string[] = [];
  const staleAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const freshAt = new Date().toISOString();
  let providerRefreshed = false;
  let returnOlderStoredSnapshot = false;
  let olderPollsAfterRefresh = 0;

  await installApiFirewall(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/api/telephony/extension-assignments" && method === "GET") {
      return fulfillJson(route, { ok: true, extensions: initiallyUnassignedExtensions(false) });
    }
    if (url.pathname === "/api/telephony/routing/priority" && method === "GET") {
      return fulfillJson(route, { ok: true, routing: routingAfterFirstAssignment(false) });
    }
    if (url.pathname === "/api/telephony/presence" && (method === "GET" || method === "POST")) {
      if (method === "POST") providerRefreshed = true;
      const useOlderStored = method === "GET" && providerRefreshed && returnOlderStoredSnapshot;
      if (useOlderStored) olderPollsAfterRefresh += 1;
      const responseCheckedAt = method === "POST" || (providerRefreshed && !useOlderStored) ? freshAt : staleAt;
      return fulfillJson(route, {
        ok: true,
        source: method === "POST" ? "provider_refresh" : "stored",
        actorRouting: null,
        routingDiagnostic: null,
        snapshot: presenceSnapshotForExtensions(initiallyUnassignedExtensions(false), responseCheckedAt),
      });
    }

    return fulfillCommonTelephonyRoute(route, unexpectedRequests);
  });

  await page.setViewportSize({ width: 1280, height: 1000 });
  await openDashboard(page);
  await page.getByRole("button", { name: "Nastavenia", exact: true }).click();
  await page.getByRole("button", { name: "Telefonovanie", exact: true }).click();

  await expect(page.getByText("Stav treba obnoviť", { exact: true })).toBeVisible();
  await expect(page.getByText("Zobrazený stav VIPTel nie je čerstvo overený.", { exact: true })).toBeVisible();
  const ownerSelect = page.getByRole("combobox", { name: "Operátor pre klapku 20", exact: true });
  await expect(ownerSelect).toBeEnabled();
  await ownerSelect.selectOption("op-natalia");
  const confirmation = page.getByRole("checkbox", {
    name: "Potvrdzujem prvé pridelenie tejto doteraz nepoužitej klapky.",
    exact: true,
  });
  await confirmation.check();
  await expect(page.getByRole("button", { name: "Uložiť priradenie", exact: true })).toBeEnabled();

  const readiness = page.getByRole("heading", { name: "Telefonovanie cez VIPTel", exact: true }).locator("xpath=ancestor::section");
  await readiness.getByRole("button", { name: "Obnoviť stav", exact: true }).click();
  await expect(readiness.getByText("Spojenie je overené", { exact: true })).toBeVisible();
  await expect(ownerSelect).toHaveValue("op-natalia");
  await expect(confirmation).toBeChecked();

  returnOlderStoredSnapshot = true;
  await expect.poll(() => olderPollsAfterRefresh, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await expect(readiness.getByText("Spojenie je overené", { exact: true })).toBeVisible();
  await expect(ownerSelect).toBeEnabled();
  await expect(ownerSelect).toHaveValue("op-natalia");
  await expect(confirmation).toBeChecked();
  await expect(page.getByRole("button", { name: "Uložiť priradenie", exact: true })).toBeEnabled();
  expect(unexpectedRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await expectNoDocumentOverflow(page);
});

test("telephony settings expose Slovak explanations, unique labels and a responsive 601-603 timeline", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const unexpectedRequests: string[] = [];

  await installApiFirewall(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/api/telephony/extension-assignments" && method === "GET") {
      return fulfillJson(route, { ok: true, extensions: extensionAssignments().slice(0, 3) });
    }
    if (url.pathname === "/api/telephony/routing/priority" && method === "GET") {
      return fulfillJson(route, { ok: true, routing: routingSnapshot(true) });
    }
    if (url.pathname === "/api/telephony/routing/lines" && method === "GET") {
      return fulfillJson(route, {
        ok: true,
        gate: { enabled: true, reason: "enabled" },
        plan: readyViptelLinePlan(),
      });
    }

    return fulfillCommonTelephonyRoute(route, unexpectedRequests);
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await openDashboard(page);
  await page.getByRole("button", { name: "Nastavenia", exact: true }).click();
  await page.getByRole("button", { name: "Telefonovanie", exact: true }).click();

  await expect(page.getByText("3 z 4 priradených", { exact: true })).toBeVisible();
  await expect(page.getByText("3 z 3 miest nastavených", { exact: true })).toBeVisible();
  await expect(page.getByText("9 čísel – postačuje", { exact: true })).toBeVisible();
  await expect(page.getByText("0412289240", { exact: true })).toBeVisible();
  const firstQueue = page.getByRole("combobox", { name: "1. volaný operátor – rad 601", exact: true });
  const secondQueue = page.getByRole("combobox", { name: "2. volaný operátor – rad 602", exact: true });
  const thirdQueue = page.getByRole("combobox", { name: "3. volaný operátor – rad 603", exact: true });
  for (const select of [firstQueue, secondQueue, thirdQueue]) {
    await expect(select).toBeVisible();
    expect(await select.evaluate((element) => (element as HTMLSelectElement).labels?.length ?? 0)).toBe(1);
  }
  await firstQueue.focus();
  await page.keyboard.press("Tab");
  await expect(secondQueue).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(thirdQueue).toBeFocused();

  const timeline = page.getByRole("list", { name: "Poradie zvonenia prichádzajúceho hovoru", exact: true });
  // The hand-off label was changed to the 20-second target in 4e1f506 but this
  // assertion was not updated, so it failed on main and -- because the suite is
  // serial -- blocked every test after it.
  await expect(timeline.getByText("cieľ: 20 sekúnd", { exact: true })).toHaveCount(2);
  await expect(timeline.getByText(/Rad 603 zvoní opakovane v slučke/)).toBeVisible();

  const glossary = page.locator("details").filter({ hasText: "Čo znamenajú technické pojmy?" });
  await glossary.locator("summary").click();
  const glossaryPairs = [
    ["Pripojenie telefónu (SIP)", "spojí s telefónnou ústredňou VIPTel"],
    ["Kontrola bez uloženia (dry-run)", "v službe VIPTel nič nezmení"],
    ["Prvé vytvorenie nastavenia (bootstrap)", "úplne prázdnych radov 601–603"],
    ["Poskytovateľ služby (provider)", "v tomto prípade VIPTel"],
  ] as const;
  for (const [term, explanation] of glossaryPairs) {
    await expect(glossary.getByText(term, { exact: true }).locator("xpath=..")).toContainText(explanation);
  }

  const steps = timeline.locator(":scope > li");
  await expect(steps).toHaveCount(3);
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const boxes = await steps.evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { height: box.height, width: box.width, x: box.x, y: box.y };
    }));
    expect(boxes).toHaveLength(3);
    expect(boxes.every((box) => box.height > 0 && box.width > 0)).toBe(true);
    if (width < 1024) {
      expect(boxes[1].y).toBeGreaterThan(boxes[0].y);
      expect(boxes[2].y).toBeGreaterThan(boxes[1].y);
    } else {
      expect(boxes[1].x).toBeGreaterThan(boxes[0].x);
      expect(boxes[2].x).toBeGreaterThan(boxes[1].x);
      expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThanOrEqual(2);
      expect(Math.abs(boxes[1].y - boxes[2].y)).toBeLessThanOrEqual(2);
    }
    const timelineOverflow = await timeline.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(timelineOverflow).toBeLessThanOrEqual(1);
    await expectNoDocumentOverflow(page, `telephony settings at ${width}px`);
  }

  expect(unexpectedRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("mobile mock webphone opens the workplace transfer picker and keeps hangup reachable", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const unexpectedRequests: string[] = [];
  let allowHangup = false;

  await installApiFirewall(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/hangup") && request.method() === "POST") {
      if (!allowHangup) {
        return fulfillJson(route, { error: "Simulovaný výpadok ukončenia hovoru." }, 503);
      }
      return fulfillJson(route, { command: { id: "hangup-command-1" } });
    }
    if (url.pathname === "/api/telephony/commands/hangup-command-1" && request.method() === "GET") {
      return fulfillJson(route, { command: { id: "hangup-command-1", status: "confirmed_by_event" } });
    }
    return fulfillCommonTelephonyRoute(route, unexpectedRequests);
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await openDashboard(page);
  await page.getByRole("button", { name: "Ústredňa", exact: true }).click();
  await expect(page.getByText("Pripravený (test)", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Číslo", exact: true }).fill("0900123456");
  await page.getByRole("button", { name: "Volať", exact: true }).click();

  // Transfer now opens the workplace/number picker directly. The unreachable
  // DTMF tone panel that used to live here has been removed: it required an
  // `onTransfer` prop that no caller ever passed.
  const transferButton = page.getByRole("button", { name: "Prepojiť hovor", exact: true });
  await expect(transferButton).toBeVisible({ timeout: 5_000 });
  await expect(transferButton).toBeEnabled();
  await transferButton.focus();
  await page.keyboard.press("Enter");
  await expect(transferButton).toHaveAttribute("aria-expanded", "true");

  await expect(page.getByText("Voľné pracoviská", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Iné telefónne číslo", exact: true })).toBeVisible();
  // The DTMF mode toggles must be gone, not merely hidden.
  await expect(page.getByRole("button", { name: "S ohlásením (*2)", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Bez ohlásenia (##)", exact: true })).toHaveCount(0);

  expect(unexpectedRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await expectNoDocumentOverflow(page);

  // Ending the call stays reachable, including with the transfer panel open.
  const hangup = page.getByRole("button", { name: "Zavesiť", exact: true });
  const bar = hangup.locator("xpath=ancestor::div[contains(@class,'fixed')]");
  await expect(bar).toBeInViewport();
  await hangup.click();

  // A failed provider hangup must never be a terminal state. It stays fail
  // closed -- no local BYE is sent behind the provider's back -- but the
  // operator is given real ways forward instead of a bare error string.
  const hangupAlert = page.getByRole("alert").filter({ hasText: "Simulovaný výpadok ukončenia hovoru." });
  await expect(hangupAlert).toBeVisible();
  await expect(hangupAlert.getByRole("button", { name: "Skúsiť znova", exact: true })).toBeVisible();
  await expect(hangupAlert.getByRole("button", { name: "Prepojiť na iné číslo", exact: true })).toBeVisible();
  // Offered here only because this is an outbound call with no queue behind it.
  await expect(hangupAlert.getByRole("button", { name: "Ukončiť len v prehliadači", exact: true })).toBeVisible();

  allowHangup = true;
  await hangupAlert.getByRole("button", { name: "Skúsiť znova", exact: true }).click();
  await expect(page.getByText("Mock hovor bol ukončený.", { exact: true })).toBeVisible();
});

test("a ringing call can be forwarded to a verified available workplace without answering", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const unexpectedRequests: string[] = [];
  const redirectBodies: unknown[] = [];
  const incomingCall = activeInboundCall({ destinationExtension: "20", queueLabel: "Rad 601" });
  const incomingId = incomingCall.id;

  await installApiFirewall(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/api/telephony/calls/active" && method === "GET") {
      return fulfillJson(route, { ok: true, checkedAt, calls: [incomingCall] });
    }
    if (url.pathname === `/api/telephony/calls/${incomingId}/redirect` && method === "POST") {
      redirectBodies.push(request.postDataJSON());
      return fulfillJson(route, { ok: true, command: { id: "incoming-redirect-command", status: "queued" } }, 202);
    }
    if (url.pathname === "/api/telephony/commands/incoming-redirect-command" && method === "GET") {
      return fulfillJson(route, { command: { id: "incoming-redirect-command", status: "confirmed_by_event" } });
    }

    return fulfillCommonTelephonyRoute(route, unexpectedRequests);
  });

  await openDashboard(page);
  const popup = page.getByRole("dialog", { name: "Klient Allianz", exact: true });
  await expect(popup).toBeVisible();
  await popup.getByRole("button", { name: "Prepojiť", exact: true }).click();
  await popup.getByRole("button", { name: /Pracovisko 21.*Mango/ }).click();
  await expect(popup.getByText(/VIPTel potvrdil prepojenie/)).toBeVisible();

  expect(redirectBodies).toEqual([{ destinationProfileId: "op-mango" }]);
  expect(unexpectedRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await expectNoDocumentOverflow(page);
});

test("a call ringing on another workstation never opens controls for this operator", async ({ page }) => {
  const unexpectedRequests: string[] = [];
  const foreignCall = activeInboundCall();

  await installApiFirewall(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/telephony/calls/active" && request.method() === "GET") {
      return fulfillJson(route, { ok: true, checkedAt, calls: [foreignCall] });
    }
    return fulfillCommonTelephonyRoute(route, unexpectedRequests);
  });

  await openDashboard(page);
  await page.getByRole("button", { name: "Ústredňa", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Klient Allianz", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Pracovisko", exact: true }).click();

  const station20 = page.locator('[data-workplace-station="20"]');
  const station21 = page.locator('[data-workplace-station="21"]');
  await expect(station21.getByText("Zvoní", { exact: true })).toBeVisible();
  await expect(station20.getByText("Zvoní", { exact: true })).toHaveCount(0);
  expect(unexpectedRequests).toEqual([]);
});

test("waiting callers are visible and selectable without opening Ustredna", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const unexpectedRequests: string[] = [];
  const first = activeInboundCall({
    id: "123e4567-e89b-42d3-a456-426614174021",
    providerCallId: "provider-call-21",
    viptelUniqueId: "viptel-call-21",
    callerName: "Prvý čakajúci",
    callerNumber: "+421900333111",
    destinationExtension: "20",
    startedAt: "2026-08-11T08:29:58.000Z",
  });
  const second = activeInboundCall({
    id: "123e4567-e89b-42d3-a456-426614174022",
    providerCallId: "provider-call-22",
    viptelUniqueId: "viptel-call-22",
    callerName: "Druhý čakajúci",
    callerNumber: "+421900333222",
    destinationExtension: "21",
    startedAt: "2026-08-11T08:29:59.000Z",
  });

  await installApiFirewall(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/telephony/calls/active" && request.method() === "GET") {
      return fulfillJson(route, { ok: true, checkedAt, calls: [second, first] });
    }
    return fulfillCommonTelephonyRoute(route, unexpectedRequests);
  });

  // Deliberately never navigates to Ustredna: the waiting room used to live
  // only there, so a dispatcher working in Dispecing could not see who was
  // waiting, let alone choose between two simultaneous callers.
  await openDashboard(page);

  // The waiting room is a header dropdown beside the operator-coverage pill. It
  // opens itself when the queue refills, so waiting callers are on screen
  // without the dispatcher going looking for them.
  const queue = page.getByRole("region", { name: "Čakajúce hovory", exact: true });
  await expect(queue).toBeVisible();
  await expect(queue.getByText("Prvý čakajúci", { exact: true })).toBeVisible();
  await expect(queue.getByText("Druhý čakajúci", { exact: true })).toBeVisible();
  // Each caller carries its own action, so the dispatcher picks one rather than
  // being handed whichever the provider listed first.
  await expect(queue.getByRole("button", { name: "Prevziať", exact: true })).toHaveCount(2);

  expect(unexpectedRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await expectNoDocumentOverflow(page);
});

test("the shared waiting room keeps simultaneous callers separate and individually selectable", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const unexpectedRequests: string[] = [];
  const first = activeInboundCall({
    id: "123e4567-e89b-42d3-a456-426614174011",
    providerCallId: "provider-call-11",
    viptelUniqueId: "viptel-call-11",
    callerName: "Prvý klient",
    callerNumber: "+421900111111",
    destinationExtension: "20",
    startedAt: "2026-08-11T08:29:58.000Z",
  });
  const second = activeInboundCall({
    id: "123e4567-e89b-42d3-a456-426614174012",
    providerCallId: "provider-call-12",
    viptelUniqueId: "viptel-call-12",
    callerName: "Druhý klient",
    callerNumber: "+421900222222",
    destinationExtension: "21",
    startedAt: "2026-08-11T08:29:59.000Z",
  });

  await installApiFirewall(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/telephony/calls/active" && request.method() === "GET") {
      return fulfillJson(route, { ok: true, checkedAt, calls: [second, first] });
    }
    return fulfillCommonTelephonyRoute(route, unexpectedRequests);
  });

  await openDashboard(page);
  await page.getByRole("button", { name: "Ústredňa", exact: true }).click();
  await page.getByRole("tab", { name: "Pracovisko", exact: true }).click();

  const waitingRoom = page.getByRole("region", { name: "Čakáreň hovorov", exact: true });
  await expect(waitingRoom).toBeVisible();
  await expect(waitingRoom.getByText("2 hovory", { exact: true })).toBeVisible();
  await expect(waitingRoom.getByText("Prvý klient", { exact: true })).toBeVisible();
  await expect(waitingRoom.getByText("+421900111111", { exact: true })).toBeVisible();
  await expect(waitingRoom.getByText("Druhý klient", { exact: true })).toBeVisible();
  await expect(waitingRoom.getByText("+421900222222", { exact: true })).toBeVisible();
  await expect(waitingRoom.getByText("Zvoní: Natália", { exact: true })).toBeVisible();
  await expect(waitingRoom.getByText("Zvoní: Mango", { exact: true })).toBeVisible();
  // The waiting room is a picker, not a read-only list: each caller carries its
  // own action so a dispatcher can choose which of several simultaneous calls
  // to take. Both remain independently addressable.
  await expect(waitingRoom.getByRole("button")).toHaveCount(2);

  expect(unexpectedRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await expectNoDocumentOverflow(page);
});

test("a connected browser call uses a final-result SIP transfer for an external number", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const unexpectedRequests: string[] = [];
  const sipTransferBodies: Array<{ body: unknown; method: string }> = [];

  await installApiFirewall(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === `/api/telephony/calls/${callId}/sip-transfer`) {
      sipTransferBodies.push({ body: request.postDataJSON(), method });
      if (method === "POST") {
        return fulfillJson(route, {
          authorizedTarget: "0900111222",
          authorizedViptelUniqueId: "viptel-call-1",
          command: { id: "external-sip-transfer-command", status: "accepted" },
          ok: true,
        }, 202);
      }
      if (method === "PATCH") return fulfillJson(route, { ok: true });
    }

    return fulfillCommonTelephonyRoute(route, unexpectedRequests);
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await openDashboard(page);
  await page.getByRole("button", { name: "Ústredňa", exact: true }).click();
  await page.getByRole("textbox", { name: "Číslo", exact: true }).fill("0900123456");
  await page.getByRole("button", { name: "Volať", exact: true }).click();

  await page.getByRole("button", { name: "Prepojiť hovor", exact: true }).click();
  const phone = page.getByRole("textbox", { name: "Iné telefónne číslo", exact: true });
  await phone.fill("+421 900 111 222");
  await phone.locator("xpath=ancestor::form").getByRole("button", { name: "Prepojiť", exact: true }).click();
  await expect.poll(() => sipTransferBodies.length).toBe(2);

  expect(sipTransferBodies).toEqual([
    { body: { destinationNumber: "+421 900 111 222" }, method: "POST" },
    {
      body: {
        commandId: "external-sip-transfer-command",
        outcome: "accepted",
        sipStatus: 202,
      },
      method: "PATCH",
    },
  ]);
  expect(unexpectedRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await expectNoDocumentOverflow(page);
});

test("browser call controls stay stable when the provider poll briefly loses the call", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const unexpectedRequests: string[] = [];
  let activeCallReads = 0;
  let loseActiveCall = false;

  await installApiFirewall(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/telephony/calls/active" && request.method() === "GET") {
      activeCallReads += 1;
      return fulfillJson(route, {
        ok: true,
        checkedAt: new Date().toISOString(),
        calls: loseActiveCall ? [] : [activeOutboundCall()],
      });
    }
    return fulfillCommonTelephonyRoute(route, unexpectedRequests);
  });

  await openDashboard(page);
  await page.getByRole("button", { name: "Ústredňa", exact: true }).click();
  await page.getByRole("textbox", { name: "Číslo", exact: true }).fill("0900123456");
  await page.getByRole("button", { name: "Volať", exact: true }).click();

  const hangup = page.getByRole("button", { name: "Zavesiť", exact: true });
  const callBar = hangup.locator("xpath=ancestor::div[contains(@class,'fixed')]");
  const createCase = callBar.getByRole("button", { name: "Vytvoriť prípad z hovoru", exact: true });
  const keypad = callBar.getByRole("button", { name: "Číselník", exact: true });
  const transfer = callBar.getByRole("button", { name: "Prepojiť hovor", exact: true });

  await expect(createCase).toBeVisible();
  await expect(createCase).toBeEnabled();
  await expect(keypad).toBeVisible();
  await expect(transfer).toBeVisible();
  const ringingBox = await callBar.boundingBox();

  await expect(keypad).toBeEnabled({ timeout: 3_000 });
  await expect(transfer).toBeEnabled();
  const readsBeforeLoss = activeCallReads;
  loseActiveCall = true;
  await expect.poll(() => activeCallReads, { timeout: 8_000 }).toBeGreaterThan(readsBeforeLoss);
  await expect(createCase).toBeVisible();
  await expect(createCase).toBeEnabled();
  await expect(callBar.getByText("0900 123 456", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Pracovisko", exact: true }).click();
  await expect(page.getByText("Smer odchádzajúceho hovoru", { exact: true })).toHaveCount(0);
  await expect(page.locator("marker#workplace-arrow")).toHaveCount(0);
  await expect(page.getByText("Žiadny aktívny hovor", { exact: true })).toHaveCount(0);
  const connectedBox = await callBar.boundingBox();
  expect(ringingBox).not.toBeNull();
  expect(connectedBox).not.toBeNull();
  expect(Math.abs((ringingBox?.width ?? 0) - (connectedBox?.width ?? 0))).toBeLessThanOrEqual(1);

  expect(unexpectedRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await expectNoDocumentOverflow(page);
});

test("incoming placeholder waits for a dialable identity before caller lookup", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const unexpectedRequests: string[] = [];
  const matchedNumbers: string[] = [];
  let activeCallReads = 0;
  let revealDialableIdentity = false;

  await installApiFirewall(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/api/telephony/calls/active" && method === "GET") {
      activeCallReads += 1;
      return fulfillJson(route, {
        ok: true,
        checkedAt,
        calls: [{
          ...activeInboundCall(),
          destinationExtension: "20",
          callerName: undefined,
          callerNumber: revealDialableIdentity ? "22" : "Prichádzajúci hovor",
        }],
      });
    }
    if (url.pathname === "/api/telephony/calls/match" && method === "GET") {
      matchedNumbers.push(url.searchParams.get("number") ?? "");
      return fulfillJson(route, { ok: true, number: matchedNumbers.at(-1), matches: [] });
    }

    return fulfillCommonTelephonyRoute(route, unexpectedRequests);
  });

  await openDashboard(page);
  await expect(page.getByRole("dialog", { name: "Prichádzajúci hovor", exact: true })).toBeVisible();
  expect(matchedNumbers).toEqual([]);

  revealDialableIdentity = true;
  await expect.poll(() => activeCallReads, { timeout: 8_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("dialog", { name: "22", exact: true })).toBeVisible();
  await expect.poll(() => matchedNumbers.length).toBeGreaterThan(0);
  expect([...new Set(matchedNumbers)]).toEqual(["22"]);

  expect(unexpectedRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("live workplace shows the real four-line route without writing through the API", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const unexpectedRequests: string[] = [];
  const mutationRequests: string[] = [];
  let providerPresenceRefreshes = 0;
  let releaseActiveCalls!: () => void;
  const activeCallsGate = new Promise<void>((resolve) => { releaseActiveCalls = resolve; });

  await installApiFirewall(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    // Session issuance and the provider snapshot requested immediately after
    // SIP registration verify the phone without changing queue routing.
    if (method === "POST" && url.pathname === "/api/telephony/presence") {
      providerPresenceRefreshes += 1;
    } else if (method !== "GET" && url.pathname !== "/api/telephony/webphone/session") {
      mutationRequests.push(`${method} ${url.pathname}`);
    }
    if (url.pathname === "/api/telephony/calls/active" && method === "GET") {
      await activeCallsGate;
      return fulfillJson(route, {
        ok: true,
        checkedAt,
        calls: [activeInboundCall(), activeOutboundCall()],
      });
    }

    return fulfillCommonTelephonyRoute(route, unexpectedRequests);
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await openDashboard(page);
  await expect(page.getByText("Voľní 3/3", { exact: true })).toBeVisible();
  const callCenterNavigation = page.getByRole("button", { name: "Ústredňa", exact: true });
  await callCenterNavigation.focus();
  releaseActiveCalls();
  const incomingDialog = page.getByRole("dialog", { name: "Klient Allianz", exact: true });
  // The call is ringing at workstation 21 while this browser owns 20. It is
  // visible in the shared workplace overview, but must never open actionable
  // incoming-call controls for this operator.
  await expect(incomingDialog).toHaveCount(0);
  await expect(callCenterNavigation).toBeFocused();
  await callCenterNavigation.click();

  const workplaceTab = page.getByRole("tab", { name: "Pracovisko", exact: true });
  await workplaceTab.focus();
  await page.keyboard.press("Enter");
  await expect(workplaceTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Pracoviská a hovory", exact: true })).toBeVisible();

  for (const position of [1, 2, 3, 4]) {
    await expect(page.getByRole("heading", { name: `Pracovné miesto ${position}`, exact: true })).toBeVisible();
  }
  for (const extensionNumber of [20, 21, 22, 23]) {
    await expect(
      page.locator(`[data-workplace-station="${extensionNumber}"]`).getByText(`Interná linka ${extensionNumber}`, { exact: true }),
    ).toBeVisible();
  }

  await expect(page.getByText("1. v poradí", { exact: true })).toBeVisible();
  await expect(page.getByText("2. v poradí", { exact: true })).toBeVisible();
  await expect(page.getByText("3. v poradí", { exact: true })).toBeVisible();
  await expect(page.getByText("Mimo poradia", { exact: true })).toBeVisible();
  await expect(page.getByText("Ak nikto nezdvihne", { exact: true })).toHaveCount(0);
  const workplaceControls = page.getByRole("complementary", { name: "Detail a ovládanie hovoru", exact: true });
  await expect(page.getByText("Aktívny hovor", { exact: true })).toHaveCount(0);
  const physicalHangup = page.getByRole("button", { name: "Zavesiť", exact: true });
  const physicalCallBar = physicalHangup.locator("xpath=ancestor::div[contains(@class,'fixed')]");
  await expect(physicalCallBar.getByRole("button", { name: "Vytvoriť prípad z hovoru", exact: true })).toBeVisible();
  await expect(physicalCallBar.getByRole("button", { name: "Prepojiť hovor", exact: true })).toBeVisible();
  await expect(physicalHangup).toBeVisible();
  await expect(physicalCallBar.getByRole("button", { name: "Stlmiť", exact: true })).toBeDisabled();
  await expect(physicalCallBar.getByRole("button", { name: "Číselník", exact: true })).toBeDisabled();
  await expectNoDocumentOverflow(page, "live workplace at 1440px");

  const watchedInboundCall = page.getByRole("button", { name: /Hovor 1.*Klient Allianz/ });
  await watchedInboundCall.click();
  await expect(workplaceControls.getByText("Klient Allianz", { exact: true })).toBeVisible();
  await expect(workplaceControls.getByText("+421900111222", { exact: true })).toBeVisible();
  await expect(workplaceControls.getByText("Hovor je iba na sledovanie", { exact: true })).toBeVisible();
  await expect(physicalHangup).toBeVisible();

  const ownOutboundCall = page.getByRole("button", { name: /Hovor 2.*0900123456/ });
  await ownOutboundCall.focus();
  await page.keyboard.press("Enter");
  await expect(workplaceControls.getByText("Hovor je iba na sledovanie", { exact: true })).toHaveCount(0);
  await expect(physicalHangup).toBeVisible();

  await page.setViewportSize({ width: 768, height: 1024 });
  await expectNoDocumentOverflow(page, "live workplace at 768px");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("region", { name: "Pracoviská a hovory", exact: true })).toBeVisible();
  await expect(page.getByText("Smer odchádzajúceho hovoru", { exact: true })).toHaveCount(0);
  await expectNoDocumentOverflow(page, "live workplace at 390px");

  expect(mutationRequests).toEqual([]);
  expect(providerPresenceRefreshes).toBe(1);
  expect(unexpectedRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("an empty workplace remains useful and keyboard reachable without API mutations", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const unexpectedRequests: string[] = [];
  const mutationRequests: string[] = [];
  let providerPresenceRefreshes = 0;

  await installApiFirewall(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/api/telephony/presence" && method === "POST") {
      providerPresenceRefreshes += 1;
    } else if (method !== "GET" && url.pathname !== "/api/telephony/webphone/session") {
      mutationRequests.push(`${method} ${url.pathname}`);
    }
    if (url.pathname === "/api/telephony/calls/active" && method === "GET") {
      return fulfillJson(route, { ok: true, checkedAt: new Date().toISOString(), calls: [] });
    }

    return fulfillCommonTelephonyRoute(route, unexpectedRequests);
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await openDashboard(page);
  await page.getByRole("button", { name: "Ústredňa", exact: true }).click();

  const overviewTab = page.getByRole("tab", { name: "Prehľad hovorov", exact: true });
  await overviewTab.focus();
  await page.keyboard.press("ArrowRight");
  const workplaceTab = page.getByRole("tab", { name: "Pracovisko", exact: true });
  await expect(workplaceTab).toBeFocused();
  await expect(workplaceTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText(
    "Momentálne neprebieha žiadny hovor. Pracovisko ďalej zobrazuje pripravenosť operátorov.",
    { exact: true },
  )).toHaveCount(0);
  await expect(page.locator("[data-workplace-station]")).toHaveCount(4);
  await expect(page.getByText("Ak nikto nezdvihne", { exact: true })).toHaveCount(0);
  await expectNoDocumentOverflow(page, "empty live workplace at 390px");

  expect(mutationRequests).toEqual([]);
  expect(providerPresenceRefreshes).toBe(1);
  expect(unexpectedRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("workplace fails closed when presence and active-call reads are unavailable", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const unexpectedRequests: string[] = [];
  const failedReads: string[] = [];
  let blockedProviderPresenceRefreshes = 0;

  await installApiFirewall(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/api/telephony/presence" && method === "POST") {
      blockedProviderPresenceRefreshes += 1;
      return fulfillJson(route, { error: "Simulovaný timeout obnovy stavu VIPTel." }, 504);
    }
    if (method === "GET" && ["/api/telephony/presence", "/api/telephony/calls/active"].includes(url.pathname)) {
      failedReads.push(url.pathname);
      return fulfillJson(route, { error: "Simulovaný timeout lokálneho QA." }, 504);
    }

    return fulfillCommonTelephonyRoute(route, unexpectedRequests);
  });

  await page.setViewportSize({ width: 768, height: 1024 });
  await openDashboard(page);
  await page.getByRole("button", { name: "Ústredňa", exact: true }).click();
  await page.getByRole("tab", { name: "Pracovisko", exact: true }).click();

  await expect(page.getByText("Príjem hovorov treba skontrolovať", { exact: true })).toBeVisible();
  await expect(page.locator('[data-workplace-station="20"]').getByText("Stav neoverený", { exact: true })).toBeVisible();
  await expect(page.locator('[data-workplace-station="21"]').getByText("Aktívny operátor", { exact: true })).toBeVisible();
  await expect(page.locator('[data-workplace-station="22"]').getByText("Aktívny operátor", { exact: true })).toBeVisible();
  await expect(page.locator('[data-workplace-station="23"]').getByText("Stav neznámy", { exact: true })).toBeVisible();
  // With both authoritative reads unavailable, every seat action fails closed.
  // The current seat stays visible, but it must not silently re-run selection.
  for (const extension of ["20", "21", "22", "23"]) {
    await expect(page.locator("#configure-workplace-" + extension)).toBeDisabled();
  }
  await expect(page.getByRole("button", { name: /^Obsadiť pracovné miesto|^Prevziať pracovné miesto/ })).toHaveCount(0);
  await expect(page.getByText("Mimo poradia", { exact: true })).toHaveCount(4);
  await expect(page.getByText("1. v poradí", { exact: true })).toHaveCount(0);
  await expect(page.getByText(
    "Momentálne neprebieha žiadny hovor. Pracovisko ďalej zobrazuje pripravenosť operátorov.",
    { exact: true },
  )).toHaveCount(0);
  await expectNoDocumentOverflow(page, "unavailable live workplace at 768px");

  expect(failedReads).toEqual(expect.arrayContaining([
    "/api/telephony/presence",
    "/api/telephony/calls/active",
  ]));
  expect(blockedProviderPresenceRefreshes).toBe(1);
  expect(unexpectedRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("manual provider refresh preempts a hanging stored presence read", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const unexpectedRequests: string[] = [];
  let storedReads = 0;
  let providerRefreshes = 0;
  let releaseHungStoredRead: () => void = () => {};
  const hungStoredRead = new Promise<void>((resolve) => {
    releaseHungStoredRead = resolve;
  });

  await installApiFirewall(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/api/telephony/presence" && method === "GET") {
      storedReads += 1;
      if (storedReads === 1) {
        await hungStoredRead;
        await route.abort("timedout").catch(() => undefined);
        return;
      }
    }
    if (url.pathname === "/api/telephony/presence" && method === "POST") {
      providerRefreshes += 1;
      const refreshedAt = new Date().toISOString();
      return fulfillJson(route, {
        ok: true,
        source: "provider_refresh",
        actorRouting: { queue: "601", revision: 7 },
        routingDiagnostic: null,
        snapshot: { ...presenceSnapshot(), checkedAt: refreshedAt },
      });
    }
    if (url.pathname === "/api/telephony/extension-assignments" && method === "GET") {
      return fulfillJson(route, { ok: true, extensions: extensionAssignments().slice(0, 3) });
    }
    if (url.pathname === "/api/telephony/routing/priority" && method === "GET") {
      return fulfillJson(route, { ok: true, routing: routingSnapshot(true) });
    }
    if (url.pathname === "/api/telephony/routing/lines" && method === "GET") {
      return fulfillJson(route, {
        ok: true,
        gate: { enabled: true, reason: "enabled" },
        plan: readyViptelLinePlan(),
      });
    }

    return fulfillCommonTelephonyRoute(route, unexpectedRequests);
  });

  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDashboard(page);
    await expect.poll(() => storedReads).toBe(1);
    await expect.poll(() => providerRefreshes, { timeout: 4_000 }).toBe(1);
    await page.getByRole("button", { name: "Nastavenia", exact: true }).click();
    await page.getByRole("button", { name: "Telefonovanie", exact: true }).click();

    const readiness = page.getByRole("heading", { name: "Telefonovanie cez VIPTel", exact: true }).locator("xpath=ancestor::section");
    await readiness.getByRole("button", { name: "Obnoviť stav", exact: true }).click();
    await expect.poll(() => providerRefreshes, { timeout: 4_000 }).toBe(2);
    await expect(readiness.getByText("Spojenie je overené", { exact: true })).toBeVisible({ timeout: 4_000 });

    expect(unexpectedRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    releaseHungStoredRead();
  }
});

test("hung telephony reads abort and the next polls recover the workplace", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  const unexpectedRequests: string[] = [];
  let presenceReads = 0;
  let activeCallReads = 0;
  let blockedProviderPresenceRefreshes = 0;
  let releaseHungPresence: () => void = () => {};
  let releaseHungActiveCalls: () => void = () => {};
  const hungPresence = new Promise<void>((resolve) => {
    releaseHungPresence = resolve;
  });
  const hungActiveCalls = new Promise<void>((resolve) => {
    releaseHungActiveCalls = resolve;
  });

  await installApiFirewall(page, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === "/api/telephony/presence" && method === "POST") {
      blockedProviderPresenceRefreshes += 1;
      return fulfillJson(route, { error: "Simulovaný timeout obnovy stavu VIPTel." }, 504);
    }

    if (url.pathname === "/api/telephony/presence" && method === "GET") {
      presenceReads += 1;
      if (presenceReads === 1) {
        await hungPresence;
        await route.abort("timedout").catch(() => undefined);
        return;
      }
      const freshCheckedAt = new Date().toISOString();
      return fulfillJson(route, {
        ok: true,
        source: "stored",
        actorRouting: { queue: "601", revision: 7 },
        routingDiagnostic: null,
        snapshot: { ...presenceSnapshot(), checkedAt: freshCheckedAt },
      });
    }

    if (url.pathname === "/api/telephony/calls/active" && method === "GET") {
      activeCallReads += 1;
      if (activeCallReads === 1) {
        await hungActiveCalls;
        await route.abort("timedout").catch(() => undefined);
        return;
      }
      return fulfillJson(route, { ok: true, checkedAt: new Date().toISOString(), calls: [] });
    }

    return fulfillCommonTelephonyRoute(route, unexpectedRequests);
  });

  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDashboard(page);
    await page.getByRole("button", { name: "Ústredňa", exact: true }).click();
    await page.getByRole("tab", { name: "Pracovisko", exact: true }).click();

  await expect(page.getByText("Príjem hovorov treba skontrolovať", { exact: true })).toBeVisible();
    await page.waitForTimeout(3_500);
    expect(activeCallReads, "the 3s poll must not overlap a hanging active-call request").toBe(1);
    await expect.poll(() => activeCallReads, { timeout: 8_000 }).toBeGreaterThanOrEqual(2);
    await expect.poll(() => presenceReads, { timeout: 8_000 }).toBeGreaterThanOrEqual(2);
    await expect(page.getByText("Príjem hovorov treba skontrolovať", { exact: true })).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByText("1. v poradí", { exact: true })).toBeVisible();
    await expectNoDocumentOverflow(page, "recovered live workplace at 1280px");

    // The initial browser-phone verification and the workplace recovery loop
    // can both request a provider snapshot. Every provider request is
    // deliberately failed above, so the exact retry count depends on timing;
    // the contract here is that recovery is attempted and a later stored poll
    // still restores the workplace.
    expect(blockedProviderPresenceRefreshes).toBeGreaterThanOrEqual(1);
    expect(unexpectedRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    releaseHungPresence();
    releaseHungActiveCalls();
  }
});

async function installApiFirewall(page: Page, handler: (route: Route) => Promise<unknown>) {
  await page.route("**/api/**", async (route) => {
    await handler(route);
  });
}

async function fulfillCommonTelephonyRoute(route: Route, unexpectedRequests: string[]) {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method();

  if (url.pathname === "/api/telephony/presence" && (method === "GET" || method === "POST")) {
    return fulfillJson(route, {
      ok: true,
      source: method === "POST" ? "provider_refresh" : "stored",
      actorRouting: { queue: "601", revision: 7 },
      routingDiagnostic: null,
      snapshot: presenceSnapshot(),
    });
  }
  if (url.pathname === "/api/telephony/workplace-selection" && method === "GET") {
    return fulfillJson(route, { ok: true, workplace: workplaceSelectionSnapshot() });
  }
  if (url.pathname === "/api/telephony/workplace-takeover" && method === "GET") {
    return fulfillJson(route, { ok: true, takeover: { checkedAt: new Date().toISOString() } });
  }
  // WorkplaceView loads the fallback-forwarding row on mount, so this is an
  // expected read whenever a test opens the Pracovisko tab.
  if (url.pathname === "/api/telephony/fallback" && method === "GET") {
    return fulfillJson(route, {
      ok: true,
      canManage: false,
      settings: { afterSeconds: 60, destination: null, enabled: false },
    });
  }
  if (url.pathname === "/api/telephony/webphone/config" && method === "GET") {
    return fulfillJson(route, {
      ok: true,
      identity: { defaultExtension: "20", extensions: [{ extension: "20", registered: true }] },
      config: {
        enabled: true,
        mockEnabled: true,
        status: "ready",
        dialMode: "sip_invite",
        credentialsExposure: "browser_test",
        browserRegistrationAllowed: true,
        allowedOrigins: ["http://127.0.0.1:3000"],
        codecs: ["opus"],
        iceServers: [],
        extensions: [{
          extension: "20",
          label: "QA klapka",
          passwordConfigured: true,
          canCallExternal: true,
          registrationEnabled: true,
        }],
        missingFields: [],
      },
    });
  }
  if (url.pathname === "/api/telephony/webphone/session" && method === "POST") {
    return fulfillJson(route, { error: "Izolovaný mock nemá SIP session." }, 409);
  }
  if (url.pathname === "/api/telephony/calls/active" && method === "GET") {
    return fulfillJson(route, { ok: true, checkedAt, calls: [activeOutboundCall()] });
  }
  if (url.pathname === "/api/telephony/calls/history" && method === "GET") {
    return fulfillJson(route, { ok: true, calls: [] });
  }
  if (url.pathname === "/api/telephony/calls/match" && method === "GET") {
    return fulfillJson(route, { ok: true, number: url.searchParams.get("number") ?? "", matches: [] });
  }
  if (/^\/api\/telephony\/calls\/[^/]+\/transfer-targets$/.test(url.pathname) && method === "GET") {
    return fulfillJson(route, {
      ok: true,
      targets: [{
        extension: "21",
        extensionId: "ext-21",
        operatorName: "Mango",
        profileId: "op-mango",
      }],
    });
  }
  if (url.pathname === "/api/telephony/directory/favorites" && method === "GET") {
    return fulfillJson(route, { favorites: [] });
  }
  if (url.pathname === "/api/telephony/directory" && method === "GET") {
    return fulfillJson(route, { contacts: [] });
  }
  if (url.pathname === "/api/telephony/routing/lines" && method === "GET") {
    return fulfillJson(route, { ok: true, gate: { enabled: false, reason: "flag_disabled" }, plan: [] });
  }
  // The console polls these two on every view, telephony test or not. They were
  // never stubbed, so any test that stayed on the dashboard long enough logged
  // them as unexpected and failed on a request list that had nothing to do with
  // what it was checking.
  if (url.pathname === "/api/notifications" && method === "GET") {
    return fulfillJson(route, { notifications: [] });
  }
  if (url.pathname === "/api/cases/location-updates" && method === "GET") {
    return fulfillJson(route, { checkedAt, notifications: [] });
  }

  unexpectedRequests.push(`${method} ${url.pathname}`);
  return fulfillJson(route, { error: "QA API firewall blocked an unexpected request." }, 599);
}

function extensionAssignments() {
  return [
    extension("ext-20", "20", "op-natalia", "Natália"),
    extension("ext-21", "21", "op-mango", "Mango"),
    extension("ext-22", "22", "op-miso", "Michal"),
    extension("ext-23", "23", undefined, "Voľná QA klapka"),
  ];
}

function fullyAssignedExtensions() {
  return extensionAssignments().map((item) => item.extension === "23"
    ? { ...item, profileId: "op-lenka", displayName: "Lenka" }
    : item);
}

function initiallyUnassignedExtensions(assigned: boolean) {
  return [
    {
      ...extension("ext-20", "20", assigned ? "op-natalia" : undefined, "Šéf"),
      assignmentRequirement: assigned ? "rotation_required" as const : "initial_provisioning" as const,
    },
    {
      ...extension("ext-21", "21", undefined, "Operator 1"),
      assignmentRequirement: "initial_provisioning" as const,
    },
    {
      ...extension("ext-22", "22", undefined, "Operator 2"),
      assignmentRequirement: "initial_provisioning" as const,
    },
    {
      ...extension("ext-23", "23", undefined, "Operator 3"),
      assignmentRequirement: "initial_provisioning" as const,
    },
  ];
}

function extension(id: string, number: string, profileId: string | undefined, displayName: string) {
  return {
    id,
    profileId,
    extension: number,
    active: true,
    assignmentEligible: true,
    displayName,
    callForwarding: "",
    registered: true,
    allowedChanges: ["profile_id"],
    lastSyncedAt: checkedAt,
  };
}

function presenceSnapshot() {
  const extensions = extensionAssignments();
  return {
    actorProfileId: "op-natalia",
    canManageAssignments: true,
    checkedAt,
    extensions,
    queues: [
      { id: "q-601", name: "601" },
      { id: "q-602", name: "602" },
      { id: "q-603", name: "603" },
    ],
    queueStatuses: [
      queueStatus("601", "20"),
      queueStatus("602", "21"),
      queueStatus("603", "22"),
    ],
  };
}

function workplaceSelectionSnapshot() {
  return {
    checkedAt,
    selection: { extension: "20", queue: "601" },
    seats: [
      { extension: "20", status: "mine", profileId: "op-natalia", profileName: "Natália", registered: true },
      { extension: "21", status: "occupied", profileId: "op-mango", profileName: "Mango", registered: true },
      { extension: "22", status: "occupied", profileId: "op-miso", profileName: "Michal", registered: true },
      { extension: "23", status: "unavailable", registered: true },
    ],
    priorities: [
      {
        queue: "601",
        order: 1,
        activeExtension: "20",
        selectedExtension: "20",
        status: "mine",
        selectionEffect: "mine",
        profileId: "op-natalia",
        profileName: "Natália",
      },
      {
        queue: "602",
        order: 2,
        activeExtension: "21",
        selectedExtension: "21",
        status: "occupied",
        selectionEffect: "swap",
        profileId: "op-mango",
        profileName: "Mango",
        willDisplace: { extension: "21", profileId: "op-mango", profileName: "Mango" },
      },
      {
        queue: "603",
        order: 3,
        activeExtension: "22",
        selectedExtension: "22",
        status: "occupied",
        selectionEffect: "swap",
        profileId: "op-miso",
        profileName: "Michal",
        willDisplace: { extension: "22", profileId: "op-miso", profileName: "Michal" },
      },
    ],
    routingStatus: {
      state: "active",
      selectedCount: 3,
      requiredCount: 3,
      message: "Poradie 601 → 602 → 603 je potvrdené uloženým provider plánom.",
    },
  };
}

function presenceSnapshotForExtensions(
  extensions: ReturnType<typeof initiallyUnassignedExtensions>,
  snapshotCheckedAt: string,
) {
  return {
    actorProfileId: "op-natalia",
    canManageAssignments: true,
    checkedAt: snapshotCheckedAt,
    extensions,
    queues: [
      { id: "q-601", name: "601" },
      { id: "q-602", name: "602" },
      { id: "q-603", name: "603" },
    ],
    queueStatuses: [
      { queue: "601", waitingCalls: 0, members: [] },
      { queue: "602", waitingCalls: 0, members: [] },
      { queue: "603", waitingCalls: 0, members: [] },
    ],
  };
}

function queueStatus(queue: string, extensionNumber: string) {
  return {
    queue,
    waitingCalls: 0,
    members: [{ extension: extensionNumber, paused: false, inUse: false, dynamic: true, callsTaken: 0 }],
  };
}

function routingSnapshot(enabled: boolean, operationStatus?: "degraded") {
  const currentPlan = [
    { queue: "601" as const, extension: "20" },
    { queue: "602" as const, extension: "21" },
    { queue: "603" as const, extension: "22" },
  ];
  const candidates = [
    candidate("ext-20", "20", "op-natalia", "Natália"),
    candidate("ext-21", "21", "op-mango", "Mango"),
    candidate("ext-22", "22", "op-miso", "Michal"),
  ];
  const operation = operationStatus
    ? {
        operationId: "routing-operation-1",
        status: operationStatus,
        baseRevision: 7,
        targetRevision: 8,
        previousPlan: currentPlan,
        targetPlan: [
          { queue: "601" as const, extension: "21" },
          { queue: "602" as const, extension: "20" },
          { queue: "603" as const, extension: "22" },
        ],
        currentStep: 1,
        stepCount: 4,
        fallback: { queue: "603" as const, extension: "22" },
        lastError: "Simulovaná neistota poskytovateľa.",
        createdAt: checkedAt,
        updatedAt: checkedAt,
      }
    : null;

  return {
    gate: { enabled, reason: enabled ? "enabled" as const : "flag_disabled" as const },
    catalog: {
      ready: true,
      queues: ["601", "602", "603"].map((queue) => ({ queue, label: `Rad ${queue}`, id: `q-${queue}`, action: "noop" as const })),
    },
    revision: 7,
    currentPlan,
    operation,
    candidates,
    actualMemberships: [
      { queue: "601", extension: "20", paused: false, inUse: false },
      { queue: "602", extension: "21", paused: false, inUse: false },
      { queue: "603", extension: "22", paused: false, inUse: false },
    ],
    waitingCalls: [
      { queue: "601", count: 0, capturedAt: checkedAt },
      { queue: "602", count: 0, capturedAt: checkedAt },
      { queue: "603", count: 0, capturedAt: checkedAt },
    ],
  };
}

function emptyRoutingSnapshot(operationStarted: boolean) {
  const previousPlan = [
    { queue: "601" as const, extension: null },
    { queue: "602" as const, extension: null },
    { queue: "603" as const, extension: null },
  ];
  const targetPlan = [
    { queue: "601" as const, extension: "20" },
    { queue: "602" as const, extension: "21" },
    { queue: "603" as const, extension: "22" },
  ];
  return {
    gate: { enabled: true, reason: "enabled" as const },
    catalog: {
      ready: true,
      queues: ["601", "602", "603"].map((queue) => ({
        queue,
        label: `Rad ${queue}`,
        id: `q-${queue}`,
        action: "noop" as const,
      })),
    },
    revision: 0,
    currentPlan: previousPlan,
    operation: operationStarted
      ? {
          operationId: "empty-bootstrap-operation",
          status: "applying" as const,
          baseRevision: 0,
          targetRevision: 1,
          previousPlan,
          targetPlan,
          currentStep: 0,
          stepCount: 3,
          fallback: { queue: "603" as const, extension: "22" },
          initialBootstrap: true as const,
          createdAt: checkedAt,
          updatedAt: checkedAt,
        }
      : null,
    candidates: [
      candidate("ext-20", "20", "op-natalia", "Natália"),
      candidate("ext-21", "21", "op-mango", "Mango"),
      candidate("ext-22", "22", "op-miso", "Michal"),
    ],
    actualMemberships: [],
    waitingCalls: [
      { queue: "601", count: 0, capturedAt: checkedAt },
      { queue: "602", count: 0, capturedAt: checkedAt },
      { queue: "603", count: 0, capturedAt: checkedAt },
    ],
  };
}

function routingAfterFirstAssignment(assigned: boolean) {
  return {
    ...emptyRoutingSnapshot(false),
    candidates: assigned
      ? [candidate("ext-20", "20", "op-natalia", "Natália")]
      : [],
  };
}

function readyViptelLinePlan() {
  const labels = [
    "Neutrálna linka",
    "Allianz Assistance",
    "Autoklub Slovakia Assistance s.r.o.",
    "AXA Assistance CZ s.r.o.",
    "Eurocross Assistance Czech Republic s.r.o.",
    "Europ Assistance",
    "LeasePlan Slovakia s.r.o.",
    "Rezerva 1",
    "Rezerva 2",
  ];
  const numbers = ["0", "1", "2", "3", "4", "5", "7", "8", "9"];

  return labels.map((label, index) => ({
    action: "noop" as const,
    label,
    phoneNumber: `041228924${numbers[index]}`,
    purpose: index === 0 ? "neutral" as const : index < 7 ? "insurer" as const : "reserve" as const,
  }));
}

function candidate(extensionId: string, extensionNumber: string, profileId: string, profileName: string) {
  return { extensionId, extension: extensionNumber, profileId, profileName, registered: true };
}

function activeOutboundCall() {
  return {
    id: callId,
    providerCallId: "provider-call-1",
    viptelUniqueId: "viptel-call-1",
    status: "outbound",
    direction: "outbound",
    callerNumber: "20",
    callerExtension: "20",
    calledNumber: "0900123456",
    destinationNumber: "0900123456",
    lineLabel: "VIPTel live",
    startedAt: checkedAt,
    waitSeconds: 0,
    recordingStatus: "not_requested",
    transcriptStatus: "not_requested",
    history: ["/api/call/statistics"],
  };
}

function activeInboundCall(overrides: Partial<CallCenterCall> = {}): CallCenterCall {
  return {
    id: "123e4567-e89b-42d3-a456-426614174001",
    providerCallId: "provider-call-2",
    viptelUniqueId: "viptel-call-2",
    status: "ringing_agent",
    direction: "inbound",
    callerName: "Klient Allianz",
    callerNumber: "+421900111222",
    calledNumber: "0412289241",
    receivedNumber: "0412289241",
    destinationExtension: "21",
    lineLabel: "Allianz Assistance",
    queueLabel: "Rad 602",
    startedAt: checkedAt,
    waitSeconds: 18,
    recordingStatus: "not_requested",
    transcriptStatus: "not_requested",
    history: ["/api/call/statistics"],
    ...overrides,
  };
}

async function fulfillJson(route: Route, json: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
}

async function openDashboard(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Linka pomoci motoristom", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true", { timeout: 30_000 });
  // The data-source chip must be rendered, but which source it names depends on
  // whether this run's route firewall satisfied the dashboard reads. Pinning it
  // to one label made every test in this file fail on the first assertion.
  await expect(page.getByText(/^Dispečing · pilotný deň · (Supabase live|Mock fallback)$/)).toBeVisible();
}

function collectConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    // Chromium logs intentionally mocked 409/503 responses as generic resource
    // errors. Their UI handling is asserted above; retain all other errors.
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function expectNoDocumentOverflow(page: Page, context = "document") {
  const result = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const overflow = document.documentElement.scrollWidth - viewportWidth;
    const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          box: `${Math.round(box.left)}..${Math.round(box.right)}`,
          className: typeof element.className === "string" ? element.className.slice(0, 120) : "",
          tag: element.tagName.toLowerCase(),
          text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80),
        };
      })
      .filter((item) => {
        const [left, right] = item.box.split("..").map(Number);
        return left < -1 || right > viewportWidth + 1;
      })
      .slice(0, 8);
    return { offenders, overflow };
  });
  expect(
    result.overflow,
    `${context} must not overflow horizontally; offenders=${JSON.stringify(result.offenders)}`,
  ).toBeLessThanOrEqual(1);
}
