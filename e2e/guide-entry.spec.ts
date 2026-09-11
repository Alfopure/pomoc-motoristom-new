import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";

const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");

test("opening the guide keeps the dispatcher window and its unfinished new case", async ({ context, page }) => {
  const origin = "https://guide-entry.test";
  const bundle = await build({ entryPoints: ["e2e/fixtures/workspace.tsx"], outfile: ".context/guide-entry.js", bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) } });
  const css = (bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "") + (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
  const writes: string[] = [];
  // Context-level interception also covers the newly opened guide window.
  await context.route("**/*", route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (!["GET", "HEAD"].includes(request.method())) { writes.push(url.pathname); return route.fulfill({ status: 409, json: { error: "Isolated guide entry test" } }); }
    if (url.pathname === "/navod") return route.fulfill({ contentType: "text/html; charset=utf-8", body: '<!doctype html><meta charset="utf-8"><h1>Návod v samostatnej karte</h1>' });
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><body><div id="root"></div></body></html>' });
    if (url.pathname === "/api/notes") return route.fulfill({ json: { notes: [] } });
    if (url.pathname === "/api/notes/colleagues") return route.fulfill({ json: { colleagues: [] } });
    if (url.pathname === "/api/version") return route.fulfill({ json: { version: "guide-entry" } });
    return route.fulfill({ status: 503, json: { error: "Isolated test" } });
  });
  await context.routeWebSocket(/.*/, socket => socket.close());
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text });
  await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true");
  await page.getByRole("button", { name: "Nový prípad", exact: true }).click();
  const textInput = page.locator('main input:not([type]), main input[type="text"]').filter({ visible: true }).last();
  await textInput.fill("Rozpracovaný údaj pred otvorením návodu");
  await page.getByRole("button", { name: "Účet Test dispečer", exact: true }).click();
  const link = page.getByRole("link", { name: /^Návod Postupy/ });
  await expect(link).toHaveAttribute("target", "_blank");
  const popupPromise = page.waitForEvent("popup");
  await link.click();
  const popup = await popupPromise;
  await expect(popup.getByRole("heading", { name: "Návod v samostatnej karte" })).toBeVisible();
  await expect(page).toHaveURL(`${origin}/`);
  await expect(textInput).toHaveValue("Rozpracovaný údaj pred otvorením návodu");
  await expect(page.getByTestId("dispatch-console")).toHaveAttribute("data-hydrated", "true");
  expect(writes).toEqual([]);
});
