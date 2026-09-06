import type { Page } from "@playwright/test";

/** Keep mocked browser checks from reaching a provider or an unintended API write.
 * Install first so each scenario can explicitly mock the mutations it exercises.
 */
export async function isolateBrowserRequests(page: Page, baseURL: string) {
  const origin = new URL(baseURL).origin;
  await page.addInitScript(() => {
    // The development-only Next.js indicator covers the first bottom tab.
    // Production has no portal; keep screenshots and clicks representative.
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal { visibility: hidden; pointer-events: none; }";
      document.head.appendChild(style);
    });
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      await route.abort("blockedbyclient");
      return;
    }
    if (url.pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      await route.fulfill({ status: 409, json: { error: "Unmocked write blocked by browser regression test." } });
      return;
    }
    await route.continue();
  });
}
