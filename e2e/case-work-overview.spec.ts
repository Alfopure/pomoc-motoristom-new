import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { existsSync } from "node:fs";
import type { OperationsWorkspace } from "../src/domain/operations";
import type { TowingWorkspace } from "../src/domain/towing/types";
import type { BranchWorkspace } from "../src/domain/work-groups";
if (existsSync("/usr/bin/google-chrome"))
  test.use({
    launchOptions: {
      executablePath: "/usr/bin/google-chrome",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  });
const origin = "https://case-work-overview.test";
const caseId = "20000000-0000-4000-8000-000000000001",
  towId = "30000000-0000-4000-8000-000000000001",
  towOperationId = "40000000-0000-4000-8000-000000000001",
  deliveryId = "40000000-0000-4000-8000-000000000002",
  requestId = "50000000-0000-4000-8000-000000000001",
  driverId = "60000000-0000-4000-8000-000000000001",
  branchId = "70000000-0000-4000-8000-000000000001";
let script = "",
  css = "";
test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["e2e/fixtures/case-work-overview.tsx"],
    outfile: ".context/case-work-overview-fixture.js",
    write: false,
    bundle: true,
    platform: "browser",
    jsx: "automatic",
    define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) },
  });
  script = bundle.outputFiles.find((f) => f.path.endsWith(".js"))!.text;
  css = bundle.outputFiles.find((f) => f.path.endsWith(".css"))!.text;
});
function fixture() {
  const operation = {
    id: towOperationId,
    kind: "tow",
    status: "assigned",
    revision: 1,
    assignmentGeneration: 1,
    caseId,
    caseNumber: "PM-TEST-535",
    fleetAssetId: null,
    vehicle: "Škoda Octavia",
    from: "Panónska cesta 38/A, Bratislava-Petržalka",
    to: "Cesta na Senec 2/A, Bratislava-Ružinov",
    scheduledAt: "2026-11-05T12:00:00Z",
    plannedEndAt: null,
    confirmedAt: null,
    startedAt: null,
    assigneeId: driverId,
    assignee: "Peter Testovací",
    cycleId: null,
    owner: "towing_order",
    ownerId: towId,
    evidenceState: "pending",
    cycle: null,
    evidence: [],
    updatedAt: "2026-11-05T11:00:00Z",
  } as const;
  const operations: OperationsWorkspace = {
    actor: {
      userId: "fixture",
      organizationId: "fixture",
      displayName: "Dispečer",
      profileId: "fixture",
      memberId: null,
      version: null,
      canDispatch: true,
    },
    operations: [
      { ...operation, evidence: [] },
      {
        ...operation,
        id: deliveryId,
        ownerId: deliveryId,
        kind: "delivery",
        owner: "logistics",
        vehicle: "Toyota Corolla · TEST002",
        status: "en_route",
        startedAt: "2026-11-05T12:10:00Z",
        from: "Pobočka Ružinov, Bratislava",
        to: "Panónska cesta 38/A, Bratislava-Petržalka",
        evidence: [],
      },
    ],
    totalCount: 2,
    members: [{ id: driverId, name: "Peter Testovací" }],
    fleet: [],
    cycles: [],
  };
  const towing: TowingWorkspace = {
    actor: {
      id: "fixture",
      userId: "fixture",
      organizationId: "fixture",
      displayName: "Dispečer",
      roles: ["manager"],
      capabilities: ["operate"],
      active: true,
      version: 1,
    },
    view: "office",
    orders: [
      {
        id: towId,
        number: "Z-TEST-0005",
        sourceCaseId: caseId,
        revision: 1,
        assignmentGeneration: 1,
        driverId,
        workStatus: "assigned",
        billingStatus: "not_ready",
        paymentStatus: "unpriced",
        fields: {
          serviceType: "tow",
          subjectType: "vehicle",
          subjectDescription: "Škoda Octavia",
          plate: "TEST001",
          pickup: operation.from,
          destination: operation.to,
          branchId,
          plannedAt: operation.scheduledAt,
        },
        authorizedCollectionCents: null,
        receivedCents: 0,
        dueCents: null,
        reconciliationRequired: false,
        createdAt: "2026-11-05T10:00:00Z",
        updatedAt: "2026-11-05T11:00:00Z",
        attachments: [],
      },
    ],
    members: [
      {
        id: driverId,
        userId: driverId,
        organizationId: "fixture",
        displayName: "Peter Testovací",
        roles: ["driver"],
        capabilities: ["drive"],
        active: true,
        version: 1,
      },
    ],
    branches: [{ id: branchId, name: "Bratislava" }],
    fleet: [],
    cashAccounts: [],
    handovers: [],
    taxConfigured: false,
    taxRates: [],
    taxDate: null,
    totalCount: 1,
  };
  const branches: BranchWorkspace = {
    actor: {
      userId: "fixture",
      organizationId: "fixture",
      displayName: "Dispečer",
      memberId: null,
      version: null,
      central: true,
      manage: true,
      leadGroups: [],
      canDeliver: false,
      canOperateTowing: true,
    },
    requests: [
      {
        id: requestId,
        kind: "tow",
        status: "assigned",
        revision: 1,
        groupId: branchId,
        groupName: "Pobočka Bratislava",
        branchName: "Bratislava",
        caseId,
        caseNumber: "PM-TEST-535",
        caseType: "Odťah",
        customer: null,
        vehicle: "Škoda Octavia",
        pickup: operation.from,
        destination: operation.to,
        dueAt: operation.scheduledAt,
        note: "",
        fleetAssetId: null,
        cycleId: null,
        routedAt: "2026-11-05T10:00:00Z",
        claimedBy: null,
        claimedByName: null,
        claimedAt: null,
        cancelReason: null,
        createdAt: "2026-11-05T10:00:00Z",
        updatedAt: "2026-11-05T11:00:00Z",
        execution: {
          operationId: towOperationId,
          owner: "towing_order",
          ownerId: towId,
          status: "assigned",
          revision: 1,
          assigneeId: driverId,
          assignee: "Peter Testovací",
          scheduledAt: operation.scheduledAt,
          plannedEndAt: null,
          confirmedAt: null,
          startedAt: null,
          finishedAt: null,
          done: false,
          cancelled: false,
        },
        related: [],
      },
    ],
    totalCount: 1,
    groups: [],
    branches: [],
    people: [],
    cycles: [],
    fleet: [],
  };
  return { operations, towing, branches };
}
async function boot(
  page: Page,
  options: {
    denyTowing?: boolean;
    delayTowing?: Promise<void>;
    long?: boolean;
  } = {},
) {
  const data = fixture(),
    requests: string[] = [],
    errors: string[] = [];
  if (options.long) {
    for (const row of data.operations.operations) {
      row.from = "A".repeat(220);
      row.to = "B".repeat(220);
    }
    data.towing.orders[0].fields.pickup = "A".repeat(220);
    data.towing.orders[0].fields.destination = "B".repeat(220);
  }
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", async (route) => {
    const r = route.request(),
      url = new URL(r.url());
    if (url.origin !== origin) throw new Error("Unexpected external request");
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;font:13px/1.45 system-ui;background:#f5f7fa}button,input,select,textarea{font:inherit}${css}</style><div id="root"></div><script>${script}</script></html>`,
      });
    requests.push(url.pathname);
    expect(url.searchParams.get("limit")).toBe(
      url.pathname === "/api/pobocky" && url.searchParams.get("view") === "open"
        ? "100"
        : "50",
    );
    if (url.pathname === "/api/operations")
      return route.fulfill({ json: data.operations });
    if (url.pathname === "/api/towing/workspace") {
      if (options.delayTowing) await options.delayTowing;
      if (options.denyTowing)
        return route.fulfill({
          status: 403,
          json: { error: "Bez oprávnenia." },
        });
      return route.fulfill({ json: data.towing });
    }
    if (url.pathname === "/api/pobocky")
      return route.fulfill({ json: data.branches });
    throw new Error(`Unexpected ${r.method()} ${url.pathname}`);
  });
  await page.goto(origin);
  return { requests, errors, data };
}
test("one tow card represents order, operation and branch execution, next to delivery", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const trace = await boot(page);
  await expect(page.locator("[data-work-key]")).toHaveCount(2);
  const tow = page.getByRole("region", { name: "Odťah", exact: true }),
    delivery = page.getByRole("region", { name: "Pristavenie", exact: true });
  await expect(tow.getByText("Z-TEST-0005")).toBeVisible();
  await expect(tow.getByText("Pobočka Bratislava")).toBeVisible();
  await expect(delivery.getByText("Na ceste", { exact: true })).toBeVisible();
  const a = await tow.boundingBox(),
    b = await delivery.boundingBox();
  expect(a!.y).toBe(b!.y);
  expect(b!.x).toBeGreaterThan(a!.x);
  expect(trace.requests).toHaveLength(3);
  expect(trace.errors).toEqual([]);
  await page.screenshot({ path: ".context/case-work-overview-1440.png" });
});
test("authorized fallback remains when towing-office access is denied", async ({
  page,
}) => {
  await boot(page, { denyTowing: true });
  await expect(page.locator("[data-work-key]")).toHaveCount(2);
  await expect(page.getByText("Časť údajov nie je dostupná.")).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Odťah", exact: true })
      .getByText("Peter Testovací"),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Otvoriť zákazku" })).toHaveCount(
    0,
  );
});
test("fast sources appear while office read is still loading, then replace the projection once", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await boot(page, { delayTowing: gate });
  await expect(page.locator("[data-work-key]")).toHaveCount(2);
  await expect(
    page.locator(`[data-work-key="operation:${towOperationId}"]`),
  ).toBeVisible();
  release();
  await expect(
    page.locator('[data-work-key="tow:' + towId + '"]'),
  ).toBeVisible();
  await expect(page.locator("[data-work-key]")).toHaveCount(2);
});
test("handoff action delegates without writing and management mounts only when expanded", async ({
  page,
}) => {
  const trace = await boot(page);
  await expect(page.locator("[data-work-key]")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Odovzdať prácu", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Odovzdanie otvorené 1" }),
  ).toBeVisible();
  expect(trace.requests).toHaveLength(3);
  await page
    .getByText("Podrobná správa jázd a zákaziek", { exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Pristavenia a návraty", exact: true }),
  ).toBeVisible();
  const search = page.getByLabel("Hľadať jazdu", { exact: true });
  await search.fill("Rozpracovaný filter");
  await page
    .getByText("Podrobná správa jázd a zákaziek", { exact: true })
    .click();
  await page
    .getByText("Podrobná správa jázd a zákaziek", { exact: true })
    .click();
  await expect(search).toHaveValue("Rozpracovaný filter");
  expect(trace.errors).toEqual([]);
});
test("closing detailed management refreshes the compact status", async ({
  page,
}) => {
  const trace = await boot(page);
  await expect(page.locator("[data-work-key]")).toHaveCount(2);
  await page
    .getByText("Podrobná správa jázd a zákaziek", { exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Pristavenia a návraty", exact: true }),
  ).toBeVisible();
  trace.data.operations.operations[1].status = "completed";
  await page
    .getByText("Podrobná správa jázd a zákaziek", { exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Pristavenie", exact: true })
      .getByText("Dokončené", { exact: true }),
  ).toBeVisible();
});
for (const width of [1024, 768, 390, 320])
  test(`long routes stay within ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const trace = await boot(page, { long: true });
    await expect(page.locator("[data-work-key]")).toHaveCount(2);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (width < 720) {
      const tow = await page
          .getByRole("region", { name: "Odťah", exact: true })
          .boundingBox(),
        delivery = await page
          .getByRole("region", { name: "Pristavenie", exact: true })
          .boundingBox();
      expect(delivery!.y).toBeGreaterThan(tow!.y);
    }
    await page.screenshot({ path: `.context/case-work-overview-${width}.png` });
    expect(trace.errors).toEqual([]);
  });
