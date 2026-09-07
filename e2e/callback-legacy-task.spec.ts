import { expect, test } from "@playwright/test";
import { build } from "esbuild";

let script: string;
test.beforeAll(async () => {
  const result = await build({ entryPoints: ["e2e/fixtures/callback-legacy-task.tsx"], bundle: true, write: false,
    outfile: "legacy-task.js", platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' } });
  script = result.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
});

for (const variant of ["page", "sidebar"] as const) {
  test(`CB-14: legacy task-only callback remains openable in actual ${variant} task selector after queue completion and scheduling`, async ({ page }) => {
    const at = "2026-09-07T08:30:00Z";
    const request = { id: "00000000-0000-4000-8000-000000000801", callerNumber: "+421900000001", callerName: "Modern request",
      source: "missed", status: "open", lineId: null, lineLabel: "Testovacia linka", partnerName: null, caseId: null,
      sessionId: null, claimedByProfileId: null, claimedByName: null, claimedAt: null, dueAt: at, createdAt: at,
      resolvedAt: null, notes: null, lastCallSessionId: null, lastCalledAt: null };
    let doneCount = 0;
    const scheduled: Record<string, unknown>[] = [];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "https://legacy-callback.test") { errors.push(`Unexpected origin ${url}`); return route.abort(); }
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div>' });
      if (url.pathname === "/api/telephony/directory") return route.fulfill({ json: { contacts: [] } });
      if (url.pathname === "/api/telephony/directory/favorites") return route.fulfill({ json: { favorites: [] } });
      if (url.pathname === "/api/telephony/callbacks") return route.fulfill({ json: {
        unifiedRequests: true, schedulingEnabled: true, configured: true, checkedAt: at, actorProfileId: "operator", actorRole: "dispatcher",
        // There is intentionally no request corresponding to legacy-task-only.
        open: doneCount ? [] : [request], resolved: doneCount ? [{ ...request, status: "done" }] : [],
      } });
      if (url.pathname === `/api/telephony/callbacks/${request.id}/done` && route.request().method() === "POST") {
        doneCount += 1; return route.fulfill({ json: { ok: true } });
      }
      if (url.pathname === "/api/telephony/calls/00000000-0000-4000-8000-000000000901/outcome" && route.request().method() === "POST") {
        scheduled.push(route.request().postDataJSON()); return route.fulfill({ json: { dispatchData: {} } });
      }
      errors.push(`Unexpected network ${url}`); return route.abort();
    });
    await page.goto(`https://legacy-callback.test/?variant=${variant}`);
    await page.addScriptTag({ content: script });
    const task = page.getByTestId(`task-card-${variant}`).filter({ hasText: "Staršia úloha: zavolať klientovi" });
    await expect(task).toHaveCount(1);
    await expect(task).toContainText("LEGACY-CB-14");
    await page.getByRole("button", { name: "Telefónna fronta", exact: true }).click();
    await page.getByRole("button", { name: "Vybavené", exact: true }).click();
    await expect(page.getByRole("button", { name: "Vybavené", exact: true })).toHaveCount(0);
    await page.getByLabel("Naplánovať spätné volanie", { exact: true }).selectOption("00000000-0000-4000-8000-000000000901");
    await page.getByRole("button", { name: "Naplánovať o 30 minút", exact: true }).click();
    await expect(page.getByText("Spätné volanie je naplánované.", { exact: true })).toBeVisible();
    expect(doneCount).toBe(1);
    expect(scheduled).toEqual([expect.objectContaining({ outcome: "callback", callbackMinutes: 30, callbackActionId: expect.stringMatching(/^[0-9a-f-]{36}$/) })]);
    // Mount the real task selector anew; checking the explanatory queue copy is insufficient.
    await page.getByRole("button", { name: "Prehľad úloh", exact: true }).click();
    await expect(task).toHaveCount(1);
    await task.getByRole("button", { name: "Staršia úloha: zavolať klientovi", exact: true }).click();
    await expect(page.getByTestId("opened-task")).toHaveText("legacy-task-only:legacy-case");
    expect(errors).toEqual([]);
  });
}
