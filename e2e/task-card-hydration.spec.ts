import { expect, test } from "@playwright/test";
import { build, type BuildOptions } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let serverHtml = "";
let clientScript = "";

test.beforeAll(async () => {
  const fixture = JSON.stringify(path.resolve("e2e/fixtures/task-card-hydration.tsx"));
  const component = `import { createElement } from "react"; import { TaskCardHydrationFixture } from ${fixture};`;
  // Only CSS names are replaced; the real task component and React SSR/hydration run unchanged.
  const common: BuildOptions = { bundle: true, write: false, jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "css-names", setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, () => ({ loader: "js",
        contents: "export default new Proxy({}, { get: (_target, key) => String(key) });" }));
    } }],
  };
  const [server, client] = await Promise.all([
    build({ ...common, platform: "node", format: "cjs", stdin: { loader: "ts", resolveDir: process.cwd(),
      contents: `${component} import { renderToString } from "react-dom/server"; console.log(renderToString(createElement(TaskCardHydrationFixture)));` } }),
    build({ ...common, platform: "browser", format: "iife", stdin: { loader: "ts", resolveDir: process.cwd(),
      contents: `${component} import { hydrateRoot } from "react-dom/client";
        window.taskCardHydration = { ready: false, errors: [] };
        hydrateRoot(document.getElementById("root"), createElement(TaskCardHydrationFixture), {
          onRecoverableError(error) { window.taskCardHydration.errors.push(error.message); }
        });` } }),
  ]);
  const directory = await mkdtemp(path.join(tmpdir(), "task-hydration-"));
  try {
    const filename = path.join(directory, "server.cjs");
    await writeFile(filename, server.outputFiles![0].text);
    // A separate process keeps the server clock zone independent from the browser and test worker.
    serverHtml = execFileSync(process.execPath, [filename], { encoding: "utf8", env: { ...process.env, TZ: "UTC" } }).trim();
  } finally { await rm(directory, { recursive: true, force: true }); }
  clientScript = client.outputFiles![0].text;
});

for (const timezoneId of ["UTC", "Europe/Bratislava", "America/New_York"]) {
  test(`UTC-rendered task deadlines hydrate without changing in ${timezoneId}`, async ({ browser }) => {
    const context = await browser.newContext({ locale: "sk-SK", timezoneId });
    try {
      const requests: string[] = [];
      await context.route("**/*", route => { requests.push(route.request().url()); return route.abort(); });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", error => pageErrors.push(error.message));
      await page.setContent(`<!doctype html><html lang="sk"><body><div id="root">${serverHtml}</div></body></html>`);
      const deadlines = page.locator("[data-task-id] .cardFooter > span:last-child");
      const before = await deadlines.allTextContents();
      await page.addScriptTag({ content: clientScript });
      await page.waitForFunction(() => window.taskCardHydration.ready);
      expect(await page.evaluate(() => window.taskCardHydration.errors)).toEqual([]);
      expect(pageErrors).toEqual([]);
      await expect(deadlines).toHaveText(["9. 10. 14:30", "9. 1. 13:30", "25. 10. 02:30", "Bez termínu"]);
      expect(await deadlines.allTextContents()).toEqual(before);
      expect(requests).toEqual([]);
    } finally { await context.close(); }
  });
}
