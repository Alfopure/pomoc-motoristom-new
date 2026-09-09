import { expect, test, type Page } from "@playwright/test";

async function enter(page: Page, name: string) {
  await page.goto("/");
  await page.getByLabel("Vaše meno", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Vstúpiť do testovania" }).click();
  await expect(
    page.getByRole("heading", { name: "Overme, že všetko funguje." }),
  ).toBeVisible();
}
async function createRun(page: Page, title: string) {
  await page.getByRole("button", { name: "Nové kolo", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Názov kola", { exact: true }).fill(title);
  await dialog
    .getByLabel("Testované zariadenie", { exact: true })
    .fill("Automatické overenie · Chrome");
  await dialog
    .getByLabel("Testovaná verzia / commit", { exact: true })
    .fill("E2E — test evidencie");
  await dialog
    .getByRole("button", { name: "Vytvoriť kolo", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#run-select")).toContainText(title);
}

test("names, shared results, conflicts, immutable history, export and mobile", async ({
  browser,
}) => {
  const suffix = Date.now();
  const contextA = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  const contextB = await browser.newContext({
    viewport: { width: 1360, height: 1000 },
  });
  const a = await contextA.newPage();
  const b = await contextB.newPage();
  const errors: string[] = [];
  a.on("pageerror", (e) => errors.push(e.message));
  b.on("pageerror", (e) => errors.push(e.message));
  await a.goto("/");
  await expect(a.getByLabel("Vaše meno", { exact: true })).toBeVisible();
  await a.screenshot({
    path: "test-results/welcome-desktop.png",
    fullPage: true,
  });
  await enter(a, "QA · Jana");
  await createRun(a, `QA · zdieľanie ${suffix}`);
  await enter(b, "QA · Peter");
  const selectedRun = await a.locator("#run-select").inputValue();
  await b.locator("#run-select").selectOption(selectedRun);
  await a.getByRole("button", { name: /^AUTH-01:/ }).click();
  await b.getByRole("button", { name: /^AUTH-01:/ }).click();
  const da = a.getByRole("dialog");
  const db = b.getByRole("dialog");
  await da.getByRole("button", { name: "Akceptované", exact: true }).click();
  await da.getByLabel(/Poznámka/).fill("Jana: prvý uložený výsledok");
  await db.getByRole("button", { name: "Neakceptované", exact: true }).click();
  await db.getByLabel(/Poznámka/).fill("Peter: môj text zostane po konflikte");
  await da
    .getByRole("button", { name: "Uložiť výsledok", exact: true })
    .click();
  await expect(da).toHaveCount(0);
  await db
    .getByRole("button", { name: "Uložiť výsledok", exact: true })
    .click();
  await expect(
    db.getByText("Novší zápis od QA · Jana", { exact: true }),
  ).toBeVisible();
  await expect(db.getByLabel(/Poznámka/)).toHaveValue(
    "Peter: môj text zostane po konflikte",
  );
  await db
    .getByRole("button", { name: "Zachovať môj text pre nový zápis" })
    .click();
  await db
    .getByRole("button", { name: "Uložiť výsledok", exact: true })
    .click();
  await expect(db).toHaveCount(0);
  await a.reload();
  await expect(a.getByRole("button", { name: /^AUTH-01:/ })).toContainText(
    "Peter: môj text",
  );
  await a.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  await a.getByRole("button", { name: /^AUTH-01:/ }).click();
  await a.getByText("História tohto testu", { exact: false }).click();
  await expect(a.getByRole("dialog").locator(".audit-event")).toHaveCount(2);
  await a
    .getByRole("dialog")
    .locator(".audit-event")
    .first()
    .getByText("Pozrieť celý zápis a pôvodné hodnoty")
    .click();
  await expect(
    a.getByRole("dialog").locator(".audit-comparison").first(),
  ).toContainText("Jana: prvý uložený výsledok");
  await expect(
    a.getByRole("dialog").locator(".audit-comparison").first(),
  ).toContainText("Peter: môj text zostane po konflikte");
  await a
    .getByRole("dialog")
    .getByRole("button", { name: "Zavrieť", exact: true })
    .click();
  const download = a.waitForEvent("download");
  await a.getByRole("button", { name: "Export CSV" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);
  await a.getByRole("button", { name: /Kompletná sada/ }).click();
  await expect(a.getByRole("button", { name: /^OPS-10:/ })).toBeVisible();
  await a.getByLabel("Hľadať test alebo poznámku").fill("callback");
  expect(await a.locator(".scenario-row").count()).toBeGreaterThan(0);
  await a.getByRole("button", { name: "Zrušiť filtre" }).click();
  await a.setViewportSize({ width: 390, height: 844 });
  await expect(a.locator(".mobile-area")).toBeVisible();
  expect(
    await a.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await a.screenshot({ path: "test-results/dashboard-mobile.png" });
  await a.getByRole("button", { name: /^CASE-01:/ }).click();
  await expect(
    a.getByRole("dialog").getByText("Očakávaný výsledok", { exact: true }),
  ).toBeVisible();
  await a.screenshot({ path: "test-results/scenario-mobile.png" });
  await a
    .getByRole("dialog")
    .getByRole("button", { name: "Zavrieť", exact: true })
    .click();
  expect(errors).toEqual([]);
  await contextA.close();
  await contextB.close();
});

test("failed save retains the draft and entering a new name retains attribution", async ({
  page,
}) => {
  await enter(page, "QA · Výpadok");
  await createRun(page, `QA · obnova ${Date.now()}`);
  await page.getByRole("button", { name: /^TASK-01:/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Blokované", exact: true }).click();
  await dialog
    .getByLabel(/Poznámka/)
    .fill("Poznámka prežije neúspešné uloženie");
  await page.route("**/api/tracker", (route) =>
    route.request().method() === "POST"
      ? route.abort("failed")
      : route.continue(),
  );
  await dialog
    .getByRole("button", { name: "Uložiť výsledok", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Spojenie sa prerušilo",
  );
  await expect(dialog.getByLabel(/Poznámka/)).toHaveValue(
    "Poznámka prežije neúspešné uloženie",
  );
  await page.unroute("**/api/tracker");
  await dialog
    .getByRole("button", { name: "Uložiť výsledok", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await page.getByTitle("Zmeniť meno").click();
  await page.getByLabel("Vaše meno", { exact: true }).fill("QA · Nové meno");
  await page.getByRole("button", { name: "Vstúpiť do testovania" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^TASK-01:/ })).toContainText(
    "QA · Výpadok",
  );
  await page.getByRole("button", { name: /^TASK-02:/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Akceptované", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Uložiť výsledok", exact: true })
    .click();
  await expect(page.getByRole("button", { name: /^TASK-02:/ })).toContainText(
    "QA · Nové meno",
  );
});

test("API rejects missing identity, cross-origin writes, forged actor and missing notes", async ({
  request,
}) => {
  expect((await request.get("/api/tracker")).status()).toBe(401);
  expect(
    (
      await request.post("/api/session", {
        data: { name: "Tester" },
        headers: { Origin: "https://external.invalid" },
      })
    ).status(),
  ).toBe(403);
  const session = await request.post("/api/session", {
    data: { name: "QA · API" },
    headers: { Origin: "http://localhost:3100" },
  });
  expect(session.status()).toBe(200);
  const actor = (await session.json()).actor;
  expect(
    (
      await request.post("/api/tracker", {
        data: { kind: "entry", actorId: "forged", requestId: "forged" },
        headers: { Origin: "http://localhost:3100" },
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await request.post("/api/tracker", {
        data: {
          kind: "saveResult",
          actorId: actor.id,
          requestId: "bad-note",
          runId: "none",
          runRevision: 1,
          scenarioId: "AUTH-01",
          revision: 0,
          input: {
            status: "blocked",
            note: "",
            severity: "",
            owner: "",
            issueUrl: "",
          },
        },
        headers: { Origin: "http://localhost:3100" },
      })
    ).status(),
  ).toBe(400);
});
