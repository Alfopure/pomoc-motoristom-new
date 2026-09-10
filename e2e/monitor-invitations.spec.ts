import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
let script: string, css: string;
test.beforeAll(async () => {
  const output = (await build({ entryPoints: ["e2e/fixtures/monitor-invitations.tsx"], bundle: true, write: false, outfile: "fixture.js", platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } })).outputFiles;
  script = output[0].text;
  css = (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});
for (const owner of [false, true]) test(`pending disconnect remains retryable with gates off for ${owner ? "inviter" : "recipient"}`, async ({ page }) => {
  const requests: { path: string; body: unknown }[] = [];
  await page.setViewportSize({ width: 360, height: 900 });
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://monitor.test") return route.abort();
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>' });
    if (route.request().method() === "POST") {
      requests.push({ path: url.pathname, body: route.request().postData() ? route.request().postDataJSON() : null });
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { enabled: false, targets: [], invitations: [{ id: "invitation-1", sessionId: "call-1", mine: owner, status: "disconnecting", inviterName: "Pozývateľ", recipientName: "Poslucháč" }] } });
  });
  // Both phone session props are null: the invitation itself identifies teardown.
  await page.goto("https://monitor.test/"); await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
  const retry = page.getByRole("button", { name: owner ? "Zopakovať odpojenie" : "Zopakovať moje odpojenie", exact: true });
  await expect(retry).toBeVisible(); expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await retry.click();
  expect(requests).toEqual([{ path: `/api/telephony/calls/call-1/${owner ? "monitor-invitations" : "stop-supervise"}`, body: owner ? { action: "revoke", invitationId: "invitation-1" } : null }]);
  await expect(page.getByRole("button", { name: "Prijať počúvanie" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
for (const width of [360, 390, 768, 1024, 1279, 1280]) test(`idle recipient invitation is reachable at ${width}px`, async ({ page }) => {
  const calls: unknown[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width, height: 900 });
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://monitor.test") return route.abort();
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>' });
    if (route.request().method() === "POST") { calls.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ json: { enabled: true, targets: [], invitations: [{ id: "invitation-1", sessionId: "call-1", mine: false, status: "pending", inviterName: "Operátor s dlhým zobrazovaným menom", expiresAt: "2026-09-10T12:02:00Z" }] } });
  });
  await page.goto("https://monitor.test/"); await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
  const accept = page.getByRole("button", { name: "Prijať počúvanie" });
  await expect(accept).toBeVisible(); expect((await accept.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await accept.click(); expect(calls).toEqual([{ action: "accept", invitationId: "invitation-1" }]);
  await expect(page.getByRole("button", { name: /whisper|barge|mikrofón/i })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
});
