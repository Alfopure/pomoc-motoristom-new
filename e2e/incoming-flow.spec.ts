import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import { routingFixture, ids, extraIds } from "./fixtures/incoming-routing-data";
import type { IncomingFlow } from "../src/lib/telephony/incoming-flow";
import type { RoutingDocument } from "../src/server/telephony/config-service";
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
let script: string, css: string;
const shotDir = process.env.ROUTING_SCREENSHOT_DIR ?? ".context";
test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] } });
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["e2e/fixtures/incoming-routing.tsx"], outfile: ".context/incoming-flow-fixture.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } });
  script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  css = (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css + bundle.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n");
});
const stepIds = [1, 2, 3].map(id => `00000000-0000-4000-8000-00000000900${id}`);
const flow: IncomingFlow = { version: 1, ending: "hangup_message", steps: [
  { id: stepIds[0], type: "ring", seconds: 20, people: [{ profileId: ids.jana, application: true, personalNumber: null }] },
  { id: stepIds[1], type: "wait", minutes: 15 },
  { id: stepIds[2], type: "repeat", stepIds: [stepIds[0]], times: 1 },
] };
function fixture(): RoutingDocument {
  return { ...structuredClone(routingFixture), snapshotId: "0".repeat(32), capabilities: { ...routingFixture.capabilities!, unifiedIncomingFlow: true },
    lines: [ { ...routingFixture.lines[0], incomingFlow: structuredClone(flow) }, { ...routingFixture.lines[0], id: extraIds.secondLine, label: "Asistenčná linka", phoneNumber: "+421232408701", incomingFlow: structuredClone(flow) } ] };
}
type Api = { mode?: "conflict" | "lost-response" | "readonly"; writes: Array<{ lines: Array<{ id: string; flow: IncomingFlow; expectedFlow: IncomingFlow | null }> }>; document?: RoutingDocument };
async function boot(page: Page, width = 1440, api: Api = { writes: [] }) {
  let document = structuredClone(api.document ?? fixture());
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width, height: 1000 });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://routing.test") return route.abort();
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>' });
    if (url.pathname === "/api/telephony/config/incoming-flow" && route.request().method() === "PUT") {
      const payload = route.request().postDataJSON(); api.writes.push(payload);
      if (api.mode === "conflict") return route.fulfill({ status: 409, json: { code: "stale_document", error: "Nastavenia medzitým zmenil kolega." } });
      document = { ...document, routingVersion: document.routingVersion + 1, lines: document.lines.map(line => ({ ...line, incomingFlow: payload.lines.find((change: { id: string }) => change.id === line.id)?.flow ?? line.incomingFlow })) };
      if (api.mode === "lost-response") return route.abort("failed");
      return route.fulfill({ json: { document, canEdit: true } });
    }
    if (url.pathname.startsWith("/api/telephony/config/")) return route.fulfill({ json: { document, canEdit: api.mode !== "readonly", canManageSettings: false } });
    return route.fulfill({ status: 503, json: { error: "Isolated fixture" } });
  });
  await page.goto("https://routing.test/?default-line");
  await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
  await expect(page.getByRole("heading", { name: "Cesta prichádzajúceho hovoru" })).toBeVisible();
  return errors;
}
for (const width of [1440, 390, 320]) test(`flow is readable without horizontal overflow at ${width}px`, async ({ page }) => {
  const errors = await boot(page, width);
  await expect(page.getByRole("article")).toHaveCount(3);
  await expect(page.getByLabel("Jana Nováková: Aplikácia", { exact: true })).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(shotDir, `unified-flow-${width}.png`), fullPage: true });
  expect(errors).toEqual([]);
});
test("missing personal number is explicit; cancelling preserves state, valid number saves with app and step", async ({ page }) => {
  const api: Api = { writes: [] }; await boot(page, 390, api);
  const checkbox = page.getByLabel("Jana Nováková: Osobné číslo", { exact: true });
  await checkbox.click(); await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Zrušiť", exact: true }).click();
  await expect(checkbox).not.toBeChecked(); expect(api.writes).toHaveLength(0);
  await checkbox.click(); await page.getByRole("dialog").getByLabel("Telefónne číslo", { exact: true }).fill("0910123456");
  await page.getByRole("button", { name: "Použiť a zapnúť" }).click();
  await expect(checkbox).toBeChecked(); await expect(page.getByLabel("Jana Nováková: Aplikácia", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Uložiť zmeny", exact: true }).click();
  await expect(page.getByText("Postupy sú uložené.", { exact: false })).toBeVisible();
  expect(api.writes).toHaveLength(1);
  expect(api.writes[0].lines[0].flow.steps[0]).toMatchObject({ people: [{ application: true, personalNumber: "+421910123456" }] });
});
test("number arrows preserve both drafts and one atomic save includes only changed lines", async ({ page }) => {
  const api: Api = { writes: [] }; await boot(page, 1440, api);
  await page.getByLabel("Sekundy zvonenia, krok 1", { exact: true }).fill("25");
  await page.getByRole("button", { name: "Nasledujúca linka" }).click();
  await expect(page.getByLabel("Sekundy zvonenia, krok 1", { exact: true })).toHaveValue("20");
  await page.getByLabel("Minúty čakania, krok 2", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Predchádzajúca linka" }).click();
  await expect(page.getByLabel("Sekundy zvonenia, krok 1", { exact: true })).toHaveValue("25");
  await page.getByRole("button", { name: "Uložiť zmeny", exact: true }).click();
  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.writes[0].lines).toHaveLength(2);
});
test("a lost save response is verified by readback without posting a second write", async ({ page }) => {
  const api: Api = { writes: [], mode: "lost-response" }; await boot(page, 1440, api);
  await page.getByLabel("Sekundy zvonenia, krok 1", { exact: true }).fill("25");
  await page.getByRole("button", { name: "Uložiť zmeny", exact: true }).click();
  await expect(page.getByText("Uložený stav je overený.", { exact: false })).toBeVisible();
  expect(api.writes).toHaveLength(1);
});
test("a concurrent edit preserves the draft and blocks blind overwrite", async ({ page }) => {
  const api: Api = { writes: [], mode: "conflict" }; await boot(page, 1440, api);
  await page.getByLabel("Sekundy zvonenia, krok 1", { exact: true }).fill("25");
  await page.getByRole("button", { name: "Uložiť zmeny", exact: true }).click();
  await expect(page.getByText("Porovnať uložené postupy a vlastný návrh")).toBeVisible();
  await expect(page.getByLabel("Sekundy zvonenia, krok 1", { exact: true })).toHaveValue("25");
  await expect(page.getByRole("button", { name: "Uložiť zmeny", exact: true })).toBeDisabled();
  expect(api.writes).toHaveLength(1);
});
test("legacy routes stay read-only until explicit conversion and saving", async ({ page }) => {
  const document = fixture(); document.lines[0].incomingFlow = null;
  const api: Api = { writes: [], document }; await boot(page, 1440, api);
  await expect(page.getByText("Táto linka používa pôvodné nastavenie")).toBeVisible();
  expect(api.writes).toHaveLength(0);
  await page.getByRole("button", { name: "Pripraviť nový postup" }).click();
  await expect(page.getByRole("button", { name: "Uložiť zmeny", exact: true })).toBeDisabled();
  expect(api.writes).toHaveLength(0);
});
