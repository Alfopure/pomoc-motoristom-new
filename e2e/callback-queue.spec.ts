import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import type { CallbackRequestPayload } from "../src/lib/telephony/callback-queue";
import { callbackOrigin } from "../src/lib/telephony/callback-origin";

let script: string;
test.beforeAll(async () => {
  const result = await build({ entryPoints: ["e2e/fixtures/callback-queue.tsx"], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' } });
  script = result.outputFiles[0].text;
});

test("the actual callback panel separates digit-confirmed requests, legacy confirmations and missed calls, and calls the selected request", async ({ page }) => {
  const at = "2026-09-07T08:30:12.000Z";
  const base: CallbackRequestPayload = { id: "explicit", callerNumber: "+421900000001", callerName: "Žiadosť klienta", source: "missed", status: "open", lineId: null, lineLabel: "Testovacia linka", partnerName: null, caseId: null, sessionId: null, claimedByProfileId: null, claimedByName: null, claimedAt: null, dueAt: at, createdAt: at, resolvedAt: null, notes: null, lastCallSessionId: null, lastCalledAt: null };
  const open = [
    { ...base, origin: callbackOrigin("missed", { request: { kind: "requested", digit: "1", requested_at: at, context: "waiting_room" } }) },
    { ...base, id: "missed", callerName: "Iba neprijatý", origin: callbackOrigin("missed", {}) },
    { ...base, id: "legacy", callerName: "Staršie potvrdenie", origin: callbackOrigin("missed", {}, { callback: { confirmed: true, requested_at: at } }) },
  ];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === "http://callback.test/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div>' });
    if (url === "http://callback.test/api/telephony/callbacks" && route.request().method() === "GET") return route.fulfill({ json: { configured: true, checkedAt: at, actorProfileId: "operator", actorRole: "dispatcher", open, resolved: [{ ...open[0], id: "resolved", status: "done" }] } });
    errors.push(`Unexpected network: ${url}`);
    return route.abort();
  });
  await page.goto("http://callback.test/");
  await page.addScriptTag({ content: script });
  await expect(page.locator("article")).toHaveCount(3);
  await page.getByRole("button", { name: "Vyžiadané klientom (2)", exact: true }).click();
  await expect(page.locator("article")).toHaveCount(2);
  const requested = page.locator("article").filter({ hasText: "Žiadosť klienta" });
  await expect(requested).toContainText("Klient stlačil 1");
  await expect(requested).toContainText("10:30:12");
  await expect(page.locator("article").filter({ hasText: "Staršie potvrdenie" })).toContainText("Klient potvrdil spätné volanie");
  await requested.getByRole("button", { name: "Zavolať", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-called", "explicit");
  await page.getByRole("button", { name: "Neprijatý hovor · bez žiadosti (1)", exact: true }).click();
  await expect(page.locator("article")).toHaveCount(1);
  await expect(page.locator("article")).toContainText("Iba neprijatý");
  await expect(page.locator("article")).not.toContainText("Klient stlačil");
  await page.locator("summary").click();
  await expect(page.locator("details")).toContainText("Klient stlačil 1");
  expect(errors).toEqual([]);
});
