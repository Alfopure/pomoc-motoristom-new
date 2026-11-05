import { expect, test } from "@playwright/test";
import { build } from "esbuild";
let script: string;
test.beforeAll(async () => {
  const output = (await build({ entryPoints: ["e2e/fixtures/workspace-provider-lifecycle.tsx"], bundle: true, write: false, outfile: "fixture.js", platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } })).outputFiles;
  script = output.find(file => file.path.endsWith(".js"))!.text;
});
for (const initiallyEnabled of [true, false]) test(`capability refresh preserves the case draft and clears published private tasks (${initiallyEnabled ? "initially enabled" : "enabled later"})`, async ({ page }) => {
  let revision = 1;
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://provider-lifecycle.test") return route.abort();
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<html><div id="root"></div></html>' });
    if (url.pathname === "/api/notes/colleagues") return route.fulfill({ json: { colleagues: [] } });
    if (url.pathname === "/api/notes") return route.fulfill({ json: { notes: [{ id: `note-${revision}`, title: `Súkromná poznámka ${revision}`, body: `Súkromný obsah ${revision}`, revision, updatedAt: "2026-09-10", ownerProfileId: "viewer", canEdit: true, recipientProfileIds: [] }] } });
    if (url.pathname === "/api/tasks") return route.fulfill({ json: { tasks: [{ id: `task-${revision}`, title: `Súkromná úloha ${revision}`, revision }] } });
    return route.abort();
  });
  await page.goto(`https://provider-lifecycle.test/${initiallyEnabled ? "" : "?legacy=1"}`); await page.addScriptTag({ content: script });
  if (!initiallyEnabled) {
    await expect(page.getByLabel("Úlohy prípadu", { exact: true })).toHaveText("Pôvodná úloha prípadu");
    await page.getByRole("button", { name: "Zmeniť dostupnosť nástrojov" }).click();
  }
  await expect(page.getByText("Súkromná poznámka 1", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Úlohy prípadu", { exact: true })).toHaveText("Súkromná úloha 1");
  await page.getByLabel("Rozpracovaný kontakt prípadu").fill("Zachovať neuložený kontakt");
  await page.getByRole("button", { name: "Zmeniť dostupnosť nástrojov" }).click();
  await expect(page.getByLabel("Rozpracovaný kontakt prípadu")).toHaveValue("Zachovať neuložený kontakt");
  await expect(page.getByText("Súkromná poznámka 1", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Načítané úlohy")).toBeEmpty();
  await expect(page.getByLabel("Úlohy prípadu", { exact: true })).toBeEmpty();
  revision = 2;
  await page.getByRole("button", { name: "Zmeniť dostupnosť nástrojov" }).click();
  await expect(page.getByText("Súkromná poznámka 2", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Načítané úlohy")).toHaveText("Súkromná úloha 2");
  await expect(page.getByLabel("Úlohy prípadu", { exact: true })).toHaveText("Súkromná úloha 2");
  await expect(page.getByLabel("Rozpracovaný kontakt prípadu")).toHaveValue("Zachovať neuložený kontakt");
  await expect(page.getByText("Súkromná poznámka 1", { exact: true })).toHaveCount(0);
});

test("disabled task workspace leaves legacy case tasks intact and performs no requests", async ({ page }) => {
  const requests: string[] = [];
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === "https://provider-lifecycle.test" && url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<html><div id="root"></div></html>' });
    requests.push(url.href);
    return route.abort();
  });
  await page.goto("https://provider-lifecycle.test/?legacy=1");
  await page.addScriptTag({ content: script });
  await expect(page.getByLabel("Načítané úlohy")).toBeEmpty();
  await page.getByLabel("Rozpracovaný kontakt prípadu").fill("Pôvodná karta prípadu");
  await page.getByRole("button", { name: "Obnoviť úlohy" }).click();
  await expect(page.getByLabel("Úlohy prípadu", { exact: true })).toHaveText("Pôvodná úloha prípadu");
  expect(requests).toEqual([]);
});

test("enabled task workspace clears its published case tasks after access is revoked", async ({ page }) => {
  let revoked = false;
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://provider-lifecycle.test") return route.abort();
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<html><div id="root"></div></html>' });
    if (url.pathname === "/api/notes/colleagues") return route.fulfill({ json: { colleagues: [] } });
    if (url.pathname === "/api/notes") return route.fulfill({ json: { notes: [] } });
    if (url.pathname === "/api/tasks") return revoked
      ? route.fulfill({ status: 403, json: { error: "Prístup bol odobratý" } })
      : route.fulfill({ json: { tasks: [{ id: "task-private", title: "Súkromná úloha", revision: 1 }] } });
    return route.abort();
  });
  await page.goto("https://provider-lifecycle.test/");
  await page.addScriptTag({ content: script });
  await expect(page.getByLabel("Úlohy prípadu", { exact: true })).toHaveText("Súkromná úloha");
  revoked = true;
  await page.getByRole("button", { name: "Obnoviť úlohy" }).click();
  await expect(page.getByLabel("Načítané úlohy")).toBeEmpty();
  await expect(page.getByLabel("Úlohy prípadu", { exact: true })).toBeEmpty();
});
