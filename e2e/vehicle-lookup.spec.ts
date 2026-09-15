import { expect, test, type Page, type Route } from "@playwright/test";
import { isolateBrowserRequests } from "./browser-isolation";
import type { DispatchData } from "../src/data/dispatch-types";
import type { VehicleFacts, VehicleLookupInput, VehicleLookupResponse } from "../src/lib/vehicle-lookup";
import * as seed from "../src/mock/seed";

test.describe.configure({ mode: "default" });
test.setTimeout(60_000);
test.beforeEach(async ({ page, baseURL }) => { await isolateBrowserRequests(page, baseURL!); });

const plateA = "QA123AB";
const plateB = "QB456CD";
const syntheticVin = "WVWZZZ1JZXW000001";
const acceptName = "Doplniť prázdne polia a prijať overenie";
type Mutation = { path: string; method: string; body: Record<string, unknown> };

function lookupResponse(input: VehicleLookupInput, overrides: VehicleFacts = {}): VehicleLookupResponse {
  const plate = input.kind === "plate" ? input.value.replace(/[\s-]/g, "") : input.knownIdentity?.plate || plateA;
  const vin = input.kind === "vin" ? input.value : syntheticVin;
  const fetchedAt = "2026-09-05T10:00:00.000Z";
  const facts: VehicleFacts = Object.fromEntries(Object.entries({
    plate, vin, make: "Fixture značka", model: "Fixture model", color: "Čierna", fuel: "Elektrina",
    technicalInspectionAt: "2025-01-15", technicalInspectionValidUntil: "2027-01-15",
    emissionInspectionAt: "2025-01-15", emissionInspectionValidUntil: "2027-01-15",
  }).map(([key, value]) => [key, { value, quality: "reported" }])) as VehicleFacts;
  return { cached: false, snapshot: { proof: "a".repeat(43), result: {
    version: 1, id: `fixture-${plate}`, query: { kind: input.kind, value: input.value.replace(/[\s-]/g, ""), country: "SK", checkedForDate: "2026-09-05" }, fetchedAt,
    sources: [
      { source: "skp", status: "found", url: "https://www.skp.sk/", fetchedAt, warnings: [], facts: {
        plate: { value: plate, quality: "reported" }, vin: { value: vin, quality: "reported" },
        insurer: { value: "Fixture poisťovňa", quality: "reported" }, insuranceStatus: { value: "POISTENÉ", quality: "reported" }, ...overrides,
      } },
      { source: "stkonline", status: "found", url: "https://www.stkonline.sk/", fetchedAt, warnings: [], facts: { ...facts, ...overrides } },
      { source: "databazavozidiel", status: "found", url: "https://www.databazavozidiel.sk/", fetchedAt, warnings: [], facts: {
        bodyType: { value: "Kombi", quality: "reported" }, drivenAxles: { value: "Predná", quality: "reported" },
        curbWeightKg: { value: "1650", quality: "reported" }, grossWeightKg: { value: "2200", quality: "reported" },
        transmission: { value: "Automatická", quality: "reported" }, transmissionGears: { value: "7", quality: "reported" },
        powerKw: { value: "150", quality: "reported" }, engineCapacityCc: { value: "1984", quality: "reported" },
        engineType: { value: "Fixture motor", quality: "reported" }, axleCount: { value: "2", quality: "reported" },
        firstRegisteredAt: { value: "2022-04-15", quality: "reported" }, wheelbaseMm: { value: "2700", quality: "reported" },
      } },
    ],
  } } };
}

function mockData(): DispatchData {
  const now = new Date().toISOString();
  return structuredClone({
    attendance: seed.attendance,
    users: seed.operators.map((operator) => ({ id: operator.id, name: operator.name, role: "dispatcher" as const, extension: operator.extension, active: true, accessStatus: "not_invited" as const, createdAt: now, updatedAt: now })),
    operators: seed.operators, branches: seed.branches, partnerDirectory: [], fleetAssets: seed.fleetAssets,
    fleetProviderVehicles: [], commanderVehicles: [], priceRules: seed.priceRules, incomingCall: seed.incomingCall,
    callCenterCalls: seed.callCenterCalls, dispatchCases: seed.dispatchCases, notifications: seed.notifications,
    metrics: seed.metrics, integrations: seed.integrations, source: "supabase" as const,
  });
}

/** All API requests terminate here: no provider calls, telephony, or database writes. */
async function sandboxApi(page: Page, lookup: (input: VehicleLookupInput) => Promise<VehicleLookupResponse> = async (input) => lookupResponse(input)) {
  const data = mockData();
  const writes: Mutation[] = [];
  const lookupInputs: VehicleLookupInput[] = [];
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path.startsWith("/api/telephony")) {
      await route.fulfill({ status: 200, json: { ok: true, enabled: false, available: false, calls: [], contacts: [], favorites: [], devices: [], events: [] } });
      return;
    }
    if (path === "/api/integrations/fleet/refresh") {
      // The dashboard refreshes feeds after mocked saves; return the unchanged fixture.
      await route.fulfill({ status: 200, json: { fleetData: data } });
      return;
    }
    if (path === "/api/vehicles/lookup") {
      const input = request.postDataJSON() as VehicleLookupInput;
      lookupInputs.push(input);
      const response = await lookup(input);
      await route.fulfill({ status: 200, json: response }).catch(() => { /* A cancelled/unmounted lookup has no consumer. */ });
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ path, method, body });
      if (/^\/api\/cases(?:\/[^/]+)?$/.test(path)) {
        const caseId = method === "POST" ? data.dispatchCases[0].id : path.split("/").at(-1)!;
        data.dispatchCases = data.dispatchCases.map((item) => item.id !== caseId ? item : {
          ...item, updatedAt: new Date().toISOString(), vehicle: { ...item.vehicle,
            licensePlate: String(body.licensePlate ?? item.vehicle.licensePlate), vin: String(body.vin ?? item.vehicle.vin ?? ""),
            make: String(body.vehicleMake ?? item.vehicle.make), model: String(body.vehicleModel ?? item.vehicle.model),
            color: String(body.vehicleColor ?? item.vehicle.color ?? ""),
            vehicleLookup: body.vehicleLookup === undefined ? item.vehicle.vehicleLookup : body.vehicleLookup as typeof item.vehicle.vehicleLookup,
          },
        });
        const caseDetail = data.dispatchCases.find(item => item.id === caseId)!;
        await route.fulfill({ status: 200, json: { caseId, dispatchData: data, caseDetail, mutationId: body.mutationId, committedRevision: caseDetail.updatedAt, warnings: [] } });
        return;
      }
      if (/^\/api\/fleet-assets(?:\/[^/]+)?$/.test(path)) {
        const assetId = method === "POST" ? "fixture-fleet-lookup" : path.split("/").at(-1)!;
        const asset = { ...data.fleetAssets[0], ...body, id: assetId } as DispatchData["fleetAssets"][number];
        data.fleetAssets = [...data.fleetAssets.filter((item) => item.id !== assetId), asset];
        await route.fulfill({ status: 200, json: { assetId, dispatchData: data } });
        return;
      }
      await route.fulfill({ status: 409, json: { error: "Unexpected mutation blocked by vehicle lookup E2E." } });
      return;
    }
    if (/^\/api\/cases\/[^/]+$/.test(path)) {
      await route.fulfill({ status: 200, json: { caseDetail: data.dispatchCases.find(item => item.id === path.split("/").at(-1)) } });
      return;
    }
    await route.fulfill({ status: 200, json: { dispatchData: data, checkedAt: new Date().toISOString(), notifications: [], updates: [], events: [], contacts: [], tasks: [] } });
  });
  return { data, writes, lookupInputs };
}

async function openDashboard(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true", { timeout: 40_000 });
}

async function navigate(page: Page, name: RegExp) {
  const mobile = (page.viewportSize()?.width ?? 1280) < 1024;
  const nav = page.getByRole("navigation", { name: mobile ? "Mobilná navigácia" : "Hlavná navigácia" });
  if (mobile && name.test("Úlohy")) {
    await nav.getByRole("button", { name: "Úlohy", exact: true }).click();
    return;
  }
  await nav.getByRole("button", { name: "Menu", exact: true }).click();
  await nav.getByRole("dialog", { name: "Obrazovky aplikácie" }).getByRole("button", { name }).click();
}

async function openNewCase(page: Page) {
  const buttons = page.getByRole("button", { name: "Nový prípad", exact: true });
  for (let index = 0; index < await buttons.count(); index += 1) {
    if (await buttons.nth(index).isVisible()) { await buttons.nth(index).click(); return; }
  }
  await navigate(page, /^Prípady/);
  await page.getByRole("button", { name: "Nový prípad", exact: true }).click();
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

for (const width of [1280, 390]) {
  test(`new case accepts only explicit proposals and preserves manual edits at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const gate = deferred();
    const api = await sandboxApi(page, async (input) => { await gate.promise; return lookupResponse(input); });
    await openDashboard(page);
    await openNewCase(page);
    const control = page.getByTestId("vehicle-lookup");
    await control.getByLabel("EČV", { exact: true }).fill(plateA);
    await control.getByRole("button", { name: "Dohľadať podľa EČV", exact: true }).click();
    await expect.poll(() => api.lookupInputs.length).toBe(1);
    await page.getByLabel("Značka", { exact: true }).fill("Ručne počas čakania");
    gate.release();
    await expect(control.getByRole("button", { name: acceptName })).toBeVisible();
    const dialog = control.getByRole("dialog", { name: /^Detail vozidla/ });
    await expect(dialog).toBeVisible();
    const technical = dialog.getByRole("region", { name: "Technické údaje pre zásah" });
    await expect(technical).toContainText("1650");
    await expect(technical).toContainText("2200");
    await expect(technical).toContainText("Predná");
    await expect(technical).toContainText("Automatická");
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const popupBounds = await dialog.boundingBox();
    expect(popupBounds!.x).toBeGreaterThanOrEqual(0);
    expect(popupBounds!.x + popupBounds!.width).toBeLessThanOrEqual(width);
    if (width === 390) {
      const screenshotPath = test.info().outputPath("vehicle-popup-mobile-390.png");
      await page.screenshot({ path: screenshotPath });
      await test.info().attach("vehicle-popup-mobile", { path: screenshotPath, contentType: "image/png" });
    }
    await page.waitForTimeout(1_400); // Deliberately longer than the real 1,200 ms autosave debounce.
    expect(api.writes).toHaveLength(0);
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue("");
    await expect(control.getByLabel("VIN", { exact: true })).toHaveValue("");
    await control.getByRole("button", { name: acceptName }).click();
    await expect(page.getByLabel("Značka", { exact: true })).toHaveValue("Ručne počas čakania");
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue("Fixture model");
    await expect(control.getByLabel("VIN", { exact: true })).toHaveValue(syntheticVin);
    await expect(page.getByLabel("Rok výroby", { exact: true })).toHaveValue("");
    expect(api.writes).toHaveLength(0);
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    expect(await control.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    if (width === 390) {
      const screenshotPath = test.info().outputPath("mobile-390.png");
      await page.screenshot({ path: screenshotPath });
      await test.info().attach("accepted-lookup-mobile", { path: screenshotPath, contentType: "image/png" });
    }
    await page.getByRole("button", { name: "Uložiť rozpracované", exact: true }).click();
    await expect.poll(() => api.writes.length).toBe(1);
    expect(api.writes[0]).toMatchObject({ method: "POST", path: "/api/cases", body: { vehicleMake: "Ručne počas čakania", vehicleModel: "Fixture model", vin: syntheticVin } });
    expect(api.writes[0].body.vehicleLookup).toEqual(lookupResponse(api.lookupInputs[0]).snapshot);
    await expect(page.getByRole("button", { name: /Uložené overenie vozidla/ })).toBeVisible();
  });
}

test("existing case proposal never autosaves; accepted snapshot survives save and ordinary edits", async ({ page }) => {
  const api = await sandboxApi(page, async (input) => lookupResponse(input, { vin: { value: input.knownIdentity!.vin!, quality: "reported" } }));
  await openDashboard(page);
  await page.getByRole("button", { name: /^Detail prípadu / }).first().click();
  const form = page.getByTestId("case-edit-form-main");
  await expect(form).toBeVisible();
  const originalMake = await form.getByLabel("Značka", { exact: true }).inputValue();
  await form.getByLabel("Model", { exact: true }).fill("");
  await expect.poll(() => api.writes.length).toBe(1);
  await expect(page.getByTestId("case-autosave-status")).toContainText("Uložené automaticky");
  api.writes.length = 0;
  await form.getByRole("button", { name: "Dohľadať podľa EČV", exact: true }).click();
  await expect(form.getByRole("button", { name: acceptName })).toBeVisible();
  await page.waitForTimeout(1_400);
  expect(api.writes).toHaveLength(0);
  await expect(form.getByLabel("Model", { exact: true })).toHaveValue("");
  await form.getByRole("button", { name: "Zavrieť návrh dohľadania", exact: true }).click();
  await page.waitForTimeout(1_400);
  expect(api.writes).toHaveLength(0);
  await form.getByRole("button", { name: "Dohľadať podľa EČV", exact: true }).click();
  await form.getByRole("button", { name: acceptName }).click();
  await expect.poll(() => api.writes.length).toBe(1);
  await expect(page.getByTestId("case-autosave-status")).toContainText("Uložené automaticky");
  expect(api.writes[0].body).toMatchObject({ vehicleModel: "Fixture model" });
  expect(api.writes[0].body).not.toHaveProperty("vehicleMake");
  await expect(form.getByLabel("Značka", { exact: true })).toHaveValue(originalMake);
  const savedSnapshot = api.writes[0].body.vehicleLookup;
  expect(savedSnapshot).toBeTruthy();
  await form.getByLabel("Farba", { exact: true }).fill("Ručne zmenená farba");
  await expect.poll(() => api.writes.length).toBe(2);
  expect(api.writes[1].body).not.toHaveProperty("vehicleLookup");
  expect(api.data.dispatchCases.find(item => api.writes[1].path.endsWith(item.id))?.vehicle.vehicleLookup).toEqual(savedSnapshot);
  await expect(form.getByLabel("Farba", { exact: true })).toHaveValue("Ručne zmenená farba");
  await navigate(page, /^Flotila/);
  await navigate(page, /^Prípady/);
  // Reopen the saved card from the case directory.
  await page.getByRole("row").filter({ hasText: "Fixture model" }).click();
  await expect(form).toBeVisible();
  await expect(page.getByRole("button", { name: /Uložené overenie vozidla/ })).toBeVisible();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("Fixture model");
});

test("fleet accepts technical dates without inventing insurance expiry and roundtrips its snapshot", async ({ page }) => {
  const api = await sandboxApi(page);
  await openDashboard(page);
  await navigate(page, /^Flotila/);
  await page.getByRole("button", { name: "Nové vozidlo", exact: true }).click();
  const fleet = page.locator("aside").filter({ has: page.getByLabel("Názov", { exact: true }) });
  await fleet.getByLabel("Názov", { exact: true }).fill("Fixture fleet lookup");
  await fleet.getByLabel("Značka", { exact: true }).fill("Ručná značka");
  await fleet.getByLabel("EČV", { exact: true }).fill(plateA);
  await page.getByRole("button", { name: "Dohľadať podľa EČV", exact: true }).click();
  await expect(page.getByRole("button", { name: acceptName })).toBeVisible();
  await page.waitForTimeout(1_400);
  expect(api.writes).toHaveLength(0);
  await expect(fleet.getByLabel("Model", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: acceptName }).click();
  await expect(fleet.getByLabel("Značka", { exact: true })).toHaveValue("Ručná značka");
  await expect(fleet.getByLabel("Poistenie do", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Uložiť vozidlo", exact: true }).click();
  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.writes[0].body).toMatchObject({ make: "Ručná značka", model: "Fixture model", technicalInspectionValidUntil: "2027-01-15", emissionInspectionValidUntil: "2027-01-15" });
  expect(api.writes[0].body.insuranceValidUntil).toBeFalsy();
  expect(api.writes[0].body.vehicleLookup).toEqual(lookupResponse(api.lookupInputs[0]).snapshot);
  await page.getByText("Upraviť interné údaje vozidla", { exact: true }).click();
  await expect(page.getByRole("button", { name: /Uložené overenie vozidla/ })).toBeVisible();
  await expect(fleet.getByLabel("Model", { exact: true })).toHaveValue("Fixture model");
});

test("changing A to B discards a delayed response and allows a clean second lookup", async ({ page }) => {
  const gate = deferred();
  const api = await sandboxApi(page, async (input) => { if (input.value === plateA) await gate.promise; return lookupResponse(input); });
  await openDashboard(page); await openNewCase(page);
  await page.getByLabel("EČV", { exact: true }).fill(plateA);
  await page.getByRole("button", { name: "Dohľadať podľa EČV", exact: true }).click();
  await expect.poll(() => api.lookupInputs.length).toBe(1);
  await page.getByLabel("EČV", { exact: true }).fill(plateB);
  gate.release();
  await page.waitForTimeout(1_400);
  await expect(page.getByRole("button", { name: acceptName })).toHaveCount(0);
  await expect(page.getByLabel("VIN", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("");
  expect(api.writes).toHaveLength(0);
  await page.getByRole("button", { name: "Dohľadať podľa EČV", exact: true }).click();
  await page.getByRole("button", { name: acceptName }).click();
  await expect(page.getByLabel("EČV", { exact: true })).toHaveValue(plateB);
  expect(api.lookupInputs.map((input) => input.value)).toEqual([plateA, plateB]);
});

test("closing a pending new case cannot restore the late proposal into a new form", async ({ page }) => {
  const gate = deferred();
  const api = await sandboxApi(page, async (input) => { await gate.promise; return lookupResponse(input); });
  await openDashboard(page); await openNewCase(page);
  await page.getByLabel("EČV", { exact: true }).fill(plateA);
  await page.getByRole("button", { name: "Dohľadať podľa EČV", exact: true }).click();
  await expect.poll(() => api.lookupInputs.length).toBe(1);
  await page.getByRole("button", { name: "Zrušiť", exact: true }).click();
  await page.getByRole("button", { name: "Odísť bez uloženia", exact: true }).click();
  gate.release();
  await openNewCase(page);
  await page.waitForTimeout(1_400);
  await expect(page.getByRole("button", { name: acceptName })).toHaveCount(0);
  await expect(page.getByLabel("EČV", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("VIN", { exact: true })).toHaveValue("");
  expect(api.writes).toHaveLength(0);
});

test("a conflicting VIN stays visible and cannot be accepted", async ({ page }) => {
  const api = await sandboxApi(page);
  await openDashboard(page); await openNewCase(page);
  await page.getByLabel("EČV", { exact: true }).fill(plateA);
  const manualVin = "WVWZZZ1JZXW000002";
  await page.getByLabel("VIN", { exact: true }).fill(manualVin);
  await page.getByRole("button", { name: "Dohľadať podľa EČV", exact: true }).click();
  await expect(page.getByTestId("vehicle-lookup").getByRole("alert")).toContainText("VIN nesúhlasí");
  await expect(page.getByRole("button", { name: acceptName })).toBeDisabled();
  const dialog = page.getByRole("dialog", { name: /^Detail vozidla/ });
  await expect(dialog.locator("header")).toContainText("Identita nesúhlasí · PZP vozidla nepotvrdené");
  await expect(dialog.locator("header")).not.toContainText("POISTENÉ");
  await expect(dialog.getByRole("region", { name: "Poistenie vozidla" })).not.toContainText("POISTENÉ");
  await dialog.getByRole("button", { name: "Zavrieť návrh dohľadania", exact: true }).click();
  const summary = page.getByRole("button", { name: /Dohľadané údaje · návrh/ });
  await expect(summary).toContainText("Identita nesúhlasí · PZP vozidla nepotvrdené");
  await expect(summary).not.toContainText("POISTENÉ");
  await expect(page.getByLabel("VIN", { exact: true })).toHaveValue(manualVin);
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("");
  expect(api.writes).toHaveLength(0);
});

test("VIN-only lookup explicitly fills a missing plate and leaves the entered VIN unchanged", async ({ page }) => {
  const api = await sandboxApi(page);
  await openDashboard(page); await openNewCase(page);
  await page.getByLabel("VIN", { exact: true }).fill(syntheticVin);
  await page.getByRole("button", { name: "Dohľadať podľa VIN", exact: true }).click();
  await expect(page.getByRole("button", { name: acceptName })).toBeEnabled();
  await expect(page.getByLabel("EČV", { exact: true })).toHaveValue("");
  expect(api.lookupInputs[0]).toMatchObject({ kind: "vin", value: syntheticVin });
  await page.getByRole("button", { name: acceptName }).click();
  await expect(page.getByLabel("EČV", { exact: true })).toHaveValue(plateA);
  await expect(page.getByLabel("VIN", { exact: true })).toHaveValue(syntheticVin);
  expect(api.writes).toHaveLength(0);
});

test("challenge and unavailable sources do not imply missing insurance or block manual saving", async ({ page }) => {
  const api = await sandboxApi(page, async (input) => {
    const response = lookupResponse(input);
    response.snapshot.result.sources.forEach((source) => { source.status = source.source === "skp" ? "challenge_required" : "unavailable"; source.facts = {}; });
    return response;
  });
  await openDashboard(page); await openNewCase(page);
  await page.getByLabel("EČV", { exact: true }).fill(plateA);
  await page.getByRole("button", { name: "Dohľadať podľa EČV", exact: true }).click();
  const control = page.getByTestId("vehicle-lookup");
  await expect(control.getByText("Vyžaduje ručné overenie", { exact: true })).toBeVisible();
  await expect(control.getByText("Zdroj sa nepodarilo overiť", { exact: true }).first()).toBeVisible();
  await expect(control).not.toContainText(/NEPOISTENÉ|nemá známku|neplatné poistenie/i);
  await expect(page.getByLabel("VIN", { exact: true })).toHaveValue("");
  await control.getByRole("button", { name: "Zavrieť návrh dohľadania", exact: true }).click();
  await expect(page.getByRole("button", { name: "Uložiť rozpracované", exact: true })).toBeEnabled();
  await page.waitForTimeout(1_400);
  expect(api.writes).toHaveLength(0);
  await page.getByRole("button", { name: "Uložiť rozpracované", exact: true }).click();
  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.writes[0].body.vehicleLookup).toBeNull();
});

test("shows source conflicts, accepts an explicit choice and flags a HAKA VIN mismatch", async ({ page }) => {
  await sandboxApi(page, async input => {
    const response = lookupResponse(input);
    response.snapshot.result.sources[0].facts.make = { value: "ŠKODA", quality: "reported" };
    response.snapshot.result.sources[1].facts.make = { value: "VOLKSWAGEN", quality: "reported" };
    response.snapshot.result.sources.push({ source: "haka", status: "found", url: "https://www.hakasystem.eu/", fetchedAt: response.snapshot.result.fetchedAt, warnings: [], facts: {}, reports: [
      { url: "https://www.hakasystem.eu/kradeze-automobilov/prispevok/123", title: "Hlásenie vozidla v HAKA", identity: { plate: plateA, vin: "WVWZZZ1JZXW000002" } },
    ] });
    return response;
  });
  await openDashboard(page); await openNewCase(page);
  const control = page.getByTestId("vehicle-lookup");
  await control.getByLabel("EČV", { exact: true }).fill(plateA);
  await control.getByRole("button", { name: "Dohľadať podľa EČV", exact: true }).click();
  await expect(control.getByText("Značka · rozdielne údaje zdrojov")).toBeVisible();
  await expect(control.getByRole("alert")).toContainText("Identita hlásenia nesúhlasí");
  await expect(control).toContainText("raz za tri mesiace");
  await expect(control.getByLabel("Značka: vyberte zdroj")).toHaveValue("");
  await control.getByLabel("Značka: vyberte zdroj").selectOption("stkonline");
  await control.getByRole("button", { name: acceptName }).click();
  await expect(page.getByLabel("Značka", { exact: true })).toHaveValue("VOLKSWAGEN");
  await expect(control.getByLabel("VIN", { exact: true })).toHaveValue(syntheticVin);
  await control.getByRole("button", { name: /Uložené overenie vozidla/ }).click();
  await expect(control.getByRole("alert")).toContainText("Identita hlásenia nesúhlasí");
});

test("automatically retries a busy lookup without a second click", async ({ page }) => {
  const api = await sandboxApi(page);
  let attempts = 0;
  await page.route("**/api/vehicles/lookup", async route => {
    if (++attempts === 1) await route.fulfill({ status: 409, headers: { "Retry-After": "1" }, json: { error: "Busy" } });
    else await route.fallback();
  });
  await openDashboard(page); await openNewCase(page);
  const control = page.getByTestId("vehicle-lookup");
  await control.getByLabel("EČV", { exact: true }).fill(plateA);
  await control.getByRole("button", { name: "Dohľadať podľa EČV", exact: true }).click();
  await expect(control.getByRole("status")).toContainText("Automaticky skúsim znova");
  await expect(control.getByRole("button", { name: acceptName })).toBeEnabled();
  expect(attempts).toBe(2);
  expect(api.lookupInputs).toHaveLength(1);
});

test("changing EČV cancels the scheduled retry", async ({ page }) => {
  await sandboxApi(page);
  let attempts = 0;
  await page.route("**/api/vehicles/lookup", async route => {
    attempts += 1;
    await route.fulfill({ status: 409, headers: { "Retry-After": "2" }, json: { error: "Busy" } });
  });
  await openDashboard(page); await openNewCase(page);
  const control = page.getByTestId("vehicle-lookup");
  await control.getByLabel("EČV", { exact: true }).fill(plateA);
  await control.getByRole("button", { name: "Dohľadať podľa EČV", exact: true }).click();
  await expect(control.getByRole("status")).toContainText("Automaticky skúsim znova");
  await control.getByLabel("EČV", { exact: true }).fill(plateB);
  await page.waitForTimeout(2200); // Beyond the server-directed retry delay.
  expect(attempts).toBe(1);
  await expect(control.getByRole("button", { name: acceptName })).toHaveCount(0);
  await expect(control.getByRole("button", { name: "Dohľadať podľa EČV", exact: true })).toBeEnabled();
});


test("vehicle popup traps focus, closes without closing its case and reopens without another lookup", async ({ page }) => {
  const api = await sandboxApi(page, async input => lookupResponse(input, { vin: { value: input.knownIdentity!.vin!, quality: "reported" } }));
  await openDashboard(page);
  await page.getByRole("button", { name: /^Detail prípadu / }).first().click();
  const form = page.getByTestId("case-edit-form-main");
  await expect(form).toBeVisible();
  const search = form.getByRole("button", { name: "Dohľadať podľa EČV", exact: true });
  await search.click();
  const dialog = form.getByRole("dialog", { name: /^Detail vozidla/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Zavrieť návrh dohľadania", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: acceptName })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Zavrieť návrh dohľadania", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(form).toBeVisible();
  await expect(search).toBeFocused();
  const reopen = form.getByRole("button", { name: /Dohľadané údaje · návrh/ });
  await reopen.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Zavrieť návrh dohľadania", exact: true }).click();
  await expect(reopen).toBeFocused();
  expect(api.lookupInputs).toHaveLength(1);
  expect(api.writes).toHaveLength(0);
});


test("a lookup completed in a retained hidden editor does not open over another screen", async ({ page }) => {
  const gate = deferred();
  const api = await sandboxApi(page, async input => { await gate.promise; return lookupResponse(input); });
  await openDashboard(page); await openNewCase(page);
  await page.getByLabel("EČV", { exact: true }).fill(plateA);
  await page.getByRole("button", { name: "Dohľadať podľa EČV", exact: true }).click();
  await expect.poll(() => api.lookupInputs.length).toBe(1);
  await navigate(page, /^Úlohy/);
  gate.release();
  await expect(page.getByTestId("vehicle-lookup").getByRole("button", { name: /Dohľadané údaje · návrh/, includeHidden: true })).toHaveCount(1);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.getByRole("navigation", { name: "Hlavná navigácia" }).getByRole("button", { name: "Nástenka", exact: true }).click();
  await page.getByRole("button", { name: /Dohľadané údaje · návrh/ }).click();
  await expect(page.getByRole("dialog", { name: /^Detail vozidla/ })).toBeVisible();
  expect(api.lookupInputs).toHaveLength(1);
  expect(api.writes).toHaveLength(0);
});


test("partial VIN suggestions require explicit confirmation before filling fields", async ({ page }) => {
  await sandboxApi(page, async input => {
    const response = lookupResponse(input);
    response.snapshot.result.sources = [{ source: "vpic", status: "found", url: "https://vpic.nhtsa.dot.gov/", fetchedAt: response.snapshot.result.fetchedAt, warnings: [], facts: {
      vin: { value: syntheticVin, quality: "reported" }, model: { value: "Návrh modelu", quality: "partial" },
    } }];
    return response;
  });
  await openDashboard(page); await openNewCase(page);
  await page.getByLabel("VIN", { exact: true }).fill(syntheticVin);
  await page.getByRole("button", { name: "Dohľadať podľa VIN", exact: true }).click();
  const confirm = page.getByRole("checkbox", { name: /Zahrnúť aj návrhy z neúplného VIN/ });
  await expect(confirm).not.toBeChecked();
  await page.getByRole("button", { name: acceptName }).click();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Dohľadať podľa VIN", exact: true }).click();
  await confirm.check();
  await page.getByRole("button", { name: acceptName }).click();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("Návrh modelu");
});
