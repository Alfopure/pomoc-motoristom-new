import "server-only";
import chromium from "@sparticuz/chromium";
import { chromium as playwright, type Browser } from "playwright-core";
import type { VehicleQuery, VehicleSourceResult } from "@/lib/vehicle-lookup";
import { parseSkp, SKP_URL } from "./skp";

let executable: Promise<string> | undefined;
async function executableBefore(deadline: number): Promise<string> {
  if (process.env.VEHICLE_LOOKUP_CHROME_PATH) return process.env.VEHICLE_LOOKUP_CHROME_PATH;
  executable ??= chromium.executablePath().catch((error) => { executable = undefined; throw error; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Decompression is a shared local asset preparation, never a provider request.
    // On timeout this caller returns without launching a browser or continuing its lookup.
    return await Promise.race([executable, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("browser_extraction_timeout")), Math.max(1, deadline - Date.now())); })]);
  } finally { clearTimeout(timer); }
}
export async function lookupSkp(query: VehicleQuery, deadline = Date.now() + 25_000): Promise<VehicleSourceResult> {
  deadline = Math.min(deadline, Date.now() + 25_000);
  let browser: Browser | undefined;
  let closing: Promise<void> | undefined;
  let timedOut = false;
  const close = () => closing ??= browser?.close().catch(() => {});
  const timeout = setTimeout(() => { timedOut = true; close(); }, Math.max(1, Math.min(25_000, deadline - Date.now())));
  try {
    // Only the immutable executable is shared. Each lookup gets a clean browser.
    const executablePath = await executableBefore(deadline);
    if (timedOut || Date.now() >= deadline) throw new Error("browser_timeout");
    browser = await playwright.launch({ executablePath, args: process.env.VEHICLE_LOOKUP_CHROME_PATH ? ["--no-sandbox"] : chromium.args, headless: true, timeout: Math.max(1, Math.min(10_000, deadline - Date.now())) });
    if (timedOut || Date.now() >= deadline) throw new Error("browser_timeout");
    const page = await browser.newPage({ locale: "sk-SK" });
    page.setDefaultTimeout(5_000);
    await page.goto(SKP_URL, { waitUntil: "domcontentloaded", timeout: 12_000 });
    await page.getByRole("button", { name: "Odmietnuť", exact: true }).click({ timeout: 800 }).catch(() => {});
    if (query.kind === "vin") await page.locator("#skp-p4r-mode-vin").check();
    await page.locator(query.kind === "vin" ? "#skp-p4r-vin" : "#skp-p4r-spz").fill(query.value);
    await page.locator("#skp-p4r-datum").fill(query.checkedForDate);
    // Native submit obtains its own reCAPTCHA token. Never replay/solve tokens.
    const [response] = await Promise.all([
      page.waitForResponse((response) => response.url() === "https://www.skp.sk/wp-json/skp-p4r/v1/check" && response.request().method() === "POST", { timeout: 12_000 }),
      page.locator("#skp-p4r-submit-main").click(),
    ]);
    const fetchedAt = new Date().toISOString();
    if (response.status() === 429) return { source: "skp", status: "rate_limited", url: SKP_URL, fetchedAt, facts: {}, warnings: [] };
    const text = await response.text();
    if (text.length > 100_000) throw new Error("response_too_large");
    return parseSkp(JSON.parse(text), query, fetchedAt);
  } catch {
    return { source: "skp", status: "unavailable", url: SKP_URL, fetchedAt: new Date().toISOString(), facts: {}, warnings: ["SKP sa nepodarilo overiť. Skúste neskôr alebo otvorte overenie PZP."] };
  } finally {
    clearTimeout(timeout);
    await close();
  }
}
