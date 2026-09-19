import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import type { createCallbackFixture as Factory } from "./fixtures/callback-shared-server";
const requireFixture = createRequire(path.resolve("package.json"));
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
let script = "", css = "", createFixture: typeof Factory;
const origin = "https://callback-shared.test";
test.beforeAll(async () => {
  await build({ entryPoints: ["e2e/fixtures/callback-shared-server.ts"], bundle: true, outfile: ".context/callback-shared-server.cjs", platform: "node", format: "cjs", alias: { "server-only": path.resolve("src/test/stubs/server-only.ts") }, packages: "external" });
  createFixture = requireFixture(path.resolve(".context/callback-shared-server.cjs")).createCallbackFixture;
  const bundle = await build({ entryPoints: ["e2e/fixtures/callback-shared.tsx"], bundle: true, write: false, outfile: ".context/callback-shared.js", platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' }, plugins: [{ name: "no-sockets", setup(builder) { builder.onResolve({ filter: /supabase\/browser$/ }, () => ({ path: path.resolve("e2e/fixtures/callback-realtime.ts") })); } }] });
  script = bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  css = (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});

test("two clients share the complete queue count through claim, failed dial, resolution, cancellation and reconnect", async ({ browser }) => {
  const server = createFixture();
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const reads = [0, 0]; const errors: string[] = [];
  let secondOffline = false;
  async function broadcast() { await Promise.all(pages.map((page) => page.evaluate(() => window.dispatchEvent(new Event("fixture-telephony-change"))))); }
  for (const [index, page] of pages.entries()) {
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { errors.push(`Unexpected network: ${url.origin}`); return route.abort(); }
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>' });
      if (secondOffline && index === 1) return route.fulfill({ status: 503, json: { error: "Testovací výpadok" } });
      const actor = index === 0 ? "one" : "two";
      try {
        if (url.pathname === "/api/telephony/callbacks") { reads[index] += 1; return route.fulfill({ json: await server.queue(actor, url.searchParams.get("cursor")) }); }
        if (url.pathname === "/api/telephony/callback-target") return route.fulfill({ json: { target: await server.target(url.searchParams.get("number")!) } });
        const action = url.pathname.match(/^\/api\/telephony\/callbacks\/([^/]+)\/(claim|call|done|cancel)$/);
        if (action) return route.fulfill({ json: await server.action(actor, action[1], action[2]) });
        errors.push(`Unexpected path: ${url.pathname}`); return route.abort();
      } catch (error) { return route.fulfill({ status: (error as { status?: number }).status ?? 500, json: { error: error instanceof Error ? error.message : String(error) } }); }
    });
    await page.goto(`${origin}/?actor=${index === 0 ? "one" : "two"}`); await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
  }
  const panel = (page: Page) => page.getByTestId("callback-workspace").getByTestId("callback-queue");
  async function counts(expected: number) {
    for (const page of pages) {
      await expect(page.locator(`summary[aria-label="Spätné volania: ${expected}"]`)).toBeVisible();
      await expect(panel(page).getByTestId("callback-total")).toHaveText(String(expected));
    }
  }
  await counts(125);
  for (const page of pages) { await expect(panel(page).locator("article")).toHaveCount(100); await expect(panel(page).getByText("Zobrazených 100 z 125:", { exact: false })).toBeVisible(); }
  expect(reads.every((count) => count <= 2)).toBe(true); // Initial load + realtime subscription catch-up, not per surface.
  await panel(pages[0]).getByRole("button", { name: "Ďalšie požiadavky (25)" }).click();
  await expect(panel(pages[0]).locator("article")).toHaveCount(125);
  await panel(pages[0]).getByRole("button", { name: "Zadané dispečerom (62)", exact: true }).click();
  await expect(panel(pages[0]).locator("article")).toHaveCount(62); await counts(125);
  await panel(pages[0]).getByRole("button", { name: "Všetky (125)", exact: true }).click();
  const firstA = panel(pages[0]).locator(`[data-callback-id="${server.ids[0]}"]`);
  const firstB = panel(pages[1]).locator(`[data-callback-id="${server.ids[0]}"]`);
  await firstA.getByRole("button", { name: "Prevziať", exact: true }).click();
  await expect.poll(() => server.rows().find((row) => row.id === server.ids[0])?.claimed_by).toBeTruthy();
  await broadcast(); await counts(125); await expect(firstB).toContainText("Požiadavku má prevzatú");
  await firstA.getByRole("button", { name: "Zavolať", exact: true }).click();
  await expect.poll(() => server.providerCalls()).toBeGreaterThan(0);
  await broadcast(); await counts(125);
  expect(server.rows().find((row) => row.id === server.ids[0])?.status).toBe("scheduled");
  await firstA.getByRole("button", { name: "Vybavené", exact: true }).click();
  await expect.poll(() => server.rows().find((row) => row.id === server.ids[0])?.status).toBe("done");
  await broadcast(); await counts(124); await expect(firstA).toHaveCount(0); await expect(firstB).toHaveCount(0);
  secondOffline = true;
  await panel(pages[0]).locator(`[data-callback-id="${server.ids[1]}"]`).getByRole("button", { name: "Zrušiť", exact: true }).click();
  await expect.poll(() => server.rows().find((row) => row.id === server.ids[1])?.status).toBe("cancelled");
  await broadcast(); await expect(panel(pages[1]).getByText("Testovací výpadok", { exact: false })).toBeVisible();
  secondOffline = false; await pages[1].evaluate(() => window.dispatchEvent(new Event("online")));
  await counts(123);
  expect(server.rows().filter((row) => row.status === "open" || row.status === "scheduled")).toHaveLength(123);
  expect(errors).toEqual([]);
  await Promise.all(contexts.map((context) => context.close()));
});
