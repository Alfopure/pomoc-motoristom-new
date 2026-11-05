import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import type { CaseWorkItem } from "../src/domain/case-work";
test.use({ timezoneId: "Europe/Bratislava" });
let script: string, css: string;
const id = (n: number) =>
  `72000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
test.beforeAll(async () => {
  const b = await build({
    entryPoints: ["e2e/fixtures/case-work.tsx"],
    bundle: true,
    write: false,
    outfile: ".context/case-work.js",
    platform: "browser",
    format: "iife",
    jsx: "automatic",
  });
  script = b.outputFiles.find((f) => f.path.endsWith(".js"))!.text;
  css = b.outputFiles.find((f) => f.path.endsWith(".css"))!.text;
});
async function boot(
  page: Page,
  {
    lost = false,
    partial = false,
    rejectAt,
    dual = false,
    hidden = false,
  }: {
    lost?: boolean;
    partial?: boolean;
    rejectAt?: number;
    dual?: boolean;
    hidden?: boolean;
  } = {},
) {
  const batches: CaseWorkItem[][] = [];
  const receipts = new Map();
  let dropped = false;
  await page.route("https://case-work.test/**", async (route) => {
    const r = route.request();
    if (!r.url().includes("/api/"))
      return route.fulfill({
        contentType: "text/html",
        body: `<html><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;font-family:Arial}${css}</style><div id="root"></div><script>${script}</script></html>`,
      });
    if (r.method() === "GET")
      return route.fulfill({
        json: {
          actorKey: "org:user",
          canOperateTowing: true,
          pickup: "Žilina",
          destination: "Servis",
          groups: [
            { id: id(60), name: "Pobočka A", kinds: ["delivery", "tow"] },
          ],
          people: [{ id: id(50), name: "Vodič A", kinds: ["delivery", "tow"] }],
          branches: [{ id: id(61), name: "Žilina" }],
          fleet: [],
          cycles: [],
        },
      });
    const rows = r.postDataJSON().items as CaseWorkItem[];
    batches.push(rows);
    if (batches.length === rejectAt)
      return route.fulfill({
        status: 400,
        json: { code: "invalid_input", error: "Skontrolujte zadanie." },
      });
    const results = rows.map((row, index) => {
      if (partial && batches.length === 1 && index === 1)
        return {
          commandId: row.commandId,
          error: "Skontrolujte pobočku.",
          status: 400,
        };
      if (!receipts.has(row.commandId))
        receipts.set(row.commandId, {
          commandId: row.commandId,
          kind: row.kind,
          owner:
            row.target.type === "branch"
              ? "branch"
              : row.kind === "tow"
                ? "towing_order"
                : "logistics",
          id: id(100 + receipts.size),
          status: row.target.type === "branch" ? "queued" : "assigned",
        });
      return { commandId: row.commandId, receipt: receipts.get(row.commandId) };
    });
    if (lost && !dropped) {
      dropped = true;
      return route.abort("failed");
    }
    return route.fulfill({ json: { results } });
  });
  await page.goto(
    `https://case-work.test/?${dual ? "dual=1" : ""}${hidden ? "&hidden=1" : ""}`,
  );
  await expect(page.getByLabel("Príjemca", { exact: true })).toHaveCount(
    hidden ? 0 : dual ? 2 : 1,
  );
  return { batches, receipts };
}
test("unsent drafts survive closing and reopening panel", async ({ page }) => {
  await boot(page);
  await page.getByLabel("Pokyny pre tohto príjemcu").fill("Zachovaný pokyn");
  await page.getByRole("button", { name: "Prepnúť panel" }).click();
  await page.getByRole("button", { name: "Prepnúť panel" }).click();
  await expect(page.getByLabel("Pokyny pre tohto príjemcu")).toHaveValue(
    "Zachovaný pokyn",
  );
});
test("two recipients keep independent notes; retry sends only the failed item", async ({
  page,
}) => {
  const trace = await boot(page, { partial: true });
  await page
    .getByLabel("Príjemca", { exact: true })
    .selectOption(`person:${id(50)}`);
  await page.getByLabel("Pokyny pre tohto príjemcu").fill("Prvý pokyn");
  await page.getByRole("button", { name: "Pridať prácu" }).click();
  await page.getByLabel("Druh práce").nth(1).selectOption("tow");
  await page
    .getByLabel("Príjemca", { exact: true })
    .nth(1)
    .selectOption(`branch:${id(60)}`);
  await page.getByLabel("Pokyny pre tohto príjemcu").nth(1).fill("Iba odťah");
  await page.getByRole("button", { name: "Odovzdať práce (2)" }).click();
  await expect(
    page.getByText("Pridelené v aplikácii", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Overiť nepotvrdené práce" }).click();
  await expect(page.getByText("V rade pobočky", { exact: true })).toBeVisible();
  expect(trace.batches.map((r) => r.length)).toEqual([2, 1]);
  expect(trace.batches[1][0]).toEqual(trace.batches[0][1]);
  expect(trace.batches[0].map((r) => r.instructions)).toEqual([
    "Prvý pokyn",
    "Iba odťah",
  ]);
});
test("lost response and reload retain the same command without duplicate work", async ({
  page,
}) => {
  const trace = await boot(page, { lost: true });
  await page
    .getByLabel("Príjemca", { exact: true })
    .selectOption(`person:${id(50)}`);
  await page.getByRole("button", { name: "Odovzdať práce (1)" }).click();
  await expect(
    page.getByText("Failed to fetch", { exact: false }),
  ).toBeVisible();
  page.on("dialog", (d) => d.accept());
  await page.reload();
  await page.getByRole("button", { name: "Overiť nepotvrdené práce" }).click();
  await expect(
    page.getByText("Pridelené v aplikácii", { exact: true }),
  ).toBeVisible();
  expect(trace.batches[1][0]).toEqual(trace.batches[0][0]);
  expect(trace.receipts.size).toBe(1);
});
test("compact form stays within mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await boot(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: ".context/case-work-320.png" });
});

test("preexecution envelope rejection unlocks only new IDs and preserves an earlier unknown intent", async ({
  page,
}) => {
  const trace = await boot(page, { lost: true, rejectAt: 2 });
  await page
    .getByLabel("Príjemca", { exact: true })
    .selectOption(`person:${id(50)}`);
  await page.getByRole("button", { name: "Odovzdať práce (1)" }).click();
  await expect(
    page.getByText("Failed to fetch", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pridať prácu" }).click();
  await page
    .getByLabel("Príjemca", { exact: true })
    .nth(1)
    .selectOption(`branch:${id(60)}`);
  await page.getByRole("button", { name: "Overiť nepotvrdené práce" }).click();
  const fix = page.getByRole("button", { name: "Upraviť odmietnuté zadanie" });
  await expect(fix).toHaveCount(1);
  await fix.click();
  await expect(
    page.getByLabel("Príjemca", { exact: true }).first(),
  ).toBeDisabled();
  await expect(
    page.getByLabel("Príjemca", { exact: true }).nth(1),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Overiť nepotvrdené práce" }).click();
  await expect(page.getByText("V rade pobočky", { exact: true })).toBeVisible();
  expect(trace.batches[2][0].commandId).toBe(trace.batches[0][0].commandId);
  expect(trace.batches[2][1].commandId).not.toBe(trace.batches[1][1].commandId);
  expect(trace.receipts.size).toBe(2);
});
test("invalid interval stays editable before any request is sent", async ({
  page,
}) => {
  const trace = await boot(page);
  await page
    .getByLabel("Príjemca", { exact: true })
    .selectOption(`person:${id(50)}`);
  await page.getByLabel("Dohodnutý termín").fill("2026-11-05T12:00");
  await page.getByLabel("Predpokladaný koniec").fill("2026-11-05T11:00");
  await page.getByRole("button", { name: "Odovzdať práce (1)" }).click();
  await expect(page.getByRole("alert")).toContainText("Koniec musí nasledovať");
  await expect(page.getByLabel("Predpokladaný koniec")).toBeEnabled();
  expect(trace.batches).toHaveLength(0);
});

test("new tow and delivery default to the local minute when the panel opens", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-11-05T12:37:45Z") });
  await boot(page, { dual: true });
  await expect(page.getByLabel("Druh práce").nth(0)).toHaveValue("tow");
  await expect(page.getByLabel("Druh práce").nth(1)).toHaveValue("delivery");
  for (const field of await page.getByLabel("Dohodnutý termín").all())
    await expect(field).toHaveValue("2026-11-05T13:37");
});
test("first opening uses the latest case job types and opening time after being hidden", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-11-05T12:37:00Z") });
  await boot(page, { hidden: true });
  await page
    .getByRole("button", { name: "Pridať pristavenie do prípadu" })
    .click();
  await page.clock.runFor(60000);
  await page.getByRole("button", { name: "Prepnúť panel" }).click();
  await expect(page.getByLabel("Druh práce")).toHaveCount(2);
  await expect(page.getByLabel("Druh práce").nth(1)).toHaveValue("delivery");
  await expect(page.getByLabel("Dohodnutý termín").first()).toHaveValue(
    "2026-11-05T13:38",
  );
});
test("reopening keeps an explicitly chosen date for both recipients", async ({
  page,
}) => {
  await boot(page, { dual: true });
  await page.getByLabel("Dohodnutý termín").first().fill("2026-12-12T15:10");
  await page
    .getByLabel("Pokyny pre tohto príjemcu")
    .nth(1)
    .fill("Iba pre pristavenie");
  await page.getByRole("button", { name: "Prepnúť panel" }).click();
  await page.getByRole("button", { name: "Prepnúť panel" }).click();
  await expect(page.getByLabel("Dohodnutý termín").first()).toHaveValue(
    "2026-12-12T15:10",
  );
  await expect(page.getByLabel("Pokyny pre tohto príjemcu").nth(1)).toHaveValue(
    "Iba pre pristavenie",
  );
});

test("opening defaults does not warn on leave but a chosen date protects the draft", async ({ page }) => {
  await boot(page, { dual: true });
  const guarded = () => page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  await expect.poll(guarded).toBe(false);
  await page.getByLabel("Dohodnutý termín").first().fill("2026-11-06T15:45");
  await expect.poll(guarded).toBe(true);
});
