import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";

const postcss = createRequire(require.resolve("@tailwindcss/postcss"))("postcss");
let script: string;
let css: string;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["e2e/fixtures/app-release.tsx"], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic" });
  script = bundle.outputFiles[0]!.text;
  css = (await postcss([tailwindcss({ base: process.cwd(), optimize: true })]).process(await readFile("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
});

for (const environment of ["test", "production"] as const) {
  for (const width of [360, 1440]) {
    test(`${environment} release is readable at ${width}px and remains the loaded version after a server refresh`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", route => route.request().url().startsWith("https://release.test/")
        ? route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="sk"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>' })
        : route.abort());
      await page.goto(`https://release.test/${environment === "production" ? "?production=1" : ""}`);
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: script });
      const badge = page.getByTestId("app-release");
      const code = page.getByTestId("app-release-code");
      await expect(badge).toBeVisible();
      await expect(badge).toContainText(environment === "test" ? "TEST" : "PRODUKCIA");
      await expect(badge).toContainText("05.10.2026");
      await expect(code).toHaveText("a123456789ab");
      await expect(code).toBeInViewport({ ratio: 1 });
      const button = page.getByRole("button", { name: "Zobraziť informácie o verzii aplikácie" });
      await button.click();
      const dialog = page.getByRole("dialog", { name: "Verzia aplikácie", exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("12345678");
      await expect(dialog).toBeInViewport({ ratio: 1 });
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(button).toBeFocused();
      await page.evaluate(() => (window as unknown as { replaceServerRelease: () => void }).replaceServerRelease());
      await expect(code).toHaveText("a123456789ab");
      await button.click();
      await expect(dialog).toContainText("05.10.2026");
      await expect(dialog).toContainText("a123456789ab");
      await expect(dialog).not.toContainText("b123456789ab");
      await dialog.getByRole("button", { name: "Zavrieť informácie o verzii" }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
    });
  }
}
