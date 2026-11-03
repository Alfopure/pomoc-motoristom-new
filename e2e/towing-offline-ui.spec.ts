import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { towingCompletionProblems } from "../src/domain/towing/validation";
import type { TowingCommand, TowingWorkspace } from "../src/domain/towing/types";

const orderId = "33333333-3333-4333-8333-333333333333";
const driverId = "11111111-1111-4111-8111-111111111111";
const workspace: TowingWorkspace = { actor: { id: driverId, userId: driverId, organizationId: "22222222-2222-4222-8222-222222222222", displayName: "Testovací vodič", roles: ["driver"], capabilities: ["drive"], active: true, version: 1 }, view: "driver", orders: [{ id: orderId, number: "Z-TEST-0001", sourceCaseId: null, revision: 1, assignmentGeneration: 1, driverId, workStatus: "in_progress", billingStatus: "not_ready", paymentStatus: "unpriced", fields: { serviceType: "tow", subjectType: "vehicle", subjectDescription: "Testovacie vozidlo", pickup: "Testovacia nakládka", destination: "Testovací servis", startedAt: "2026-10-13T09:00:00Z", startSource: "assignment", branchId: "77777777-7777-4777-8777-777777777777", contact: "Syntetický kontakt" }, authorizedCollectionCents: 10000, receivedCents: 0, dueCents: null, reconciliationRequired: false, createdAt: "2026-10-13T09:00:00Z", updatedAt: "2026-10-13T09:00:00Z", attachments: [{ id: "88888888-8888-4888-8888-888888888888", kind: "work", name: "online-work.png", mimeType: "image/png", size: 100, status: "ready", createdAt: "2026-10-13T09:00:00Z" }] }], members: [], branches: [], fleet: [], cashAccounts: [{ id: "66666666-6666-4666-8666-666666666666", driverId, balanceCents: 0, reservedCents: 0, revision: 1 }], handovers: [], taxConfigured: false, taxRates: [], taxDate: null };

let javascript = ""; let css = "";
test.beforeAll(async () => {
  const result = await build({ stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import { OfflineDriver } from './src/components/towing/offline/OfflineDriver'; import * as store from './src/components/towing/offline/store'; window.__offlineStore=store; const w=window.__fixture; const identity={userId:w.actor.userId,organizationId:w.actor.organizationId,membershipId:w.actor.id,environment:location.origin}; window.__identity=identity; async function mount(){if(!(await store.scopesForUser(identity.userId,location.origin)).length) await store.rememberOrder(identity,w.actor,w.orders[0],{issuedAt:Date.now(),expiresAt:Date.now()+43200000});createRoot(document.getElementById('root')).render(<OfflineDriver/>);} mount();`, resolveDir: path.resolve("."), loader: "tsx" }, bundle: true, jsx: "automatic", write: false, outfile: "offline-harness.js", platform: "browser", define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "isolated-synthetic-session", setup(builder) { builder.onResolve({ filter: /lib\/supabase\/browser$/ }, () => ({ path: "session", namespace: "fixture" })); builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `export function createSupabaseBrowserClient(){const user=window.__fixture.actor; return {auth:{getSession:async()=>({data:{session:{user:{id:user.userId},expires_at:Math.floor(Date.now()/1000)+3600}}}),getUser:async()=>({data:{user:{id:user.userId}}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})}};}`, loader: "js" })); } }], logLevel: "silent" });
  javascript = result.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  // Use the real production CSS so the mobile layout assertions cover actual utilities.
  const files = (await readdir(".next/static/chunks")).filter(file => file.endsWith(".css"));
  css = (await Promise.all(files.map(file => readFile(path.join(".next/static/chunks", file), "utf8")))).join("\n");
});

test("360px offline work survives reload and foreground sync orders fields, photos, cash and completion", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const state = structuredClone(workspace); const commands: TowingCommand[] = []; const phases: string[] = [];
  await page.route("https://towing-offline.test/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<html lang="sk"><body><div id="root"></div></body></html>' });
    if (url.pathname === "/api/towing/access") return route.fulfill({ json: { actor: state.actor, order: state.orders[0], cashAccount: state.cashAccounts[0], lease: { issuedAt: Date.now(), expiresAt: Date.now() + 43200000 } } });
    if (url.pathname === "/api/towing/commands") {
      const command = route.request().postDataJSON() as TowingCommand; commands.push(command); phases.push(command.type);
      if (command.type === "update_order") { state.orders[0].fields = { ...state.orders[0].fields, ...command.payload.fields as object }; state.orders[0].revision++; }
      if (command.type === "receive_payment") { state.orders[0].receivedCents += Number(command.payload.amountCents); state.cashAccounts[0].balanceCents += Number(command.payload.amountCents); state.cashAccounts[0].revision++; }
      if (command.type === "submit") { const problems = towingCompletionProblems(state.orders[0]); if (problems.length) return route.fulfill({ status: 400, json: { error: problems.join(" ") } }); state.orders[0].workStatus = "submitted"; state.orders[0].revision++; }
      return route.fulfill({ json: { commandId: command.commandId, targetId: command.targetId, revision: state.orders[0].revision } });
    }
    if (url.pathname.endsWith("/attachments")) { phases.push("upload"); state.orders[0].attachments.push({ id: "99999999-9999-4999-8999-999999999999", kind: "handover", name: "handover.png", mimeType: "image/png", size: 100, status: "ready", createdAt: "2026-10-13T11:00:00Z" }); state.orders[0].revision++; return route.fulfill({ json: { revision: state.orders[0].revision, targetId: orderId, commandId: /name="commandId"\r\n\r\n([^\r\n]+)/.exec(route.request().postDataBuffer()!.toString("utf8"))?.[1] } }); }
    return route.fulfill({ status: 404, json: { error: "Not a synthetic test endpoint" } });
  });
  const boot = async () => {
    await page.goto("https://towing-offline.test/");
    await page.evaluate(value => { (window as unknown as { __fixture: TowingWorkspace }).__fixture = value; Object.defineProperty(navigator, "onLine", { get: () => false, configurable: true }); }, workspace);
    await page.addStyleTag({ content: css }); await page.addScriptTag({ content: javascript });
    await expect(page.getByRole("heading", { name: "Z-TEST-0001 · Testovacie vozidlo" })).toBeVisible();
  };
  await boot();
  await page.getByRole("textbox", { name: "Poznámka k výkonu", exact: true }).fill("Práca uložená bez signálu.");
  await page.getByRole("textbox", { name: "Koniec", exact: true }).fill("2026-10-13T11:00");
  await expect(page.getByRole("button", { name: "Pripraviť dokončenie", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Uložiť údaje v zariadení" }).click();
  await expect(page.getByRole("status")).toContainText("Uložené v zariadení");
  await page.getByRole("combobox", { name: "Typ fotografie", exact: true }).selectOption("handover");
  await page.getByLabel("Fotografia", { exact: true }).setInputFiles({ name: "handover.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6A2sAAAAASUVORK5CYII=", "base64") });
  await page.getByRole("button", { name: "Uložiť fotografiu", exact: true }).click();
  await page.getByRole("textbox", { name: "Skutočne prijatá hotovosť (€)", exact: true }).fill("20.00");
  await page.getByRole("checkbox", { name: "Túto hotovosť som skutočne prijal." }).check(); await page.getByRole("button", { name: "Zaznamenať prijatú hotovosť" }).click();
  await expect(page.getByRole("textbox", { name: "Skutočne prijatá hotovosť (€)", exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Pripraviť dokončenie", exact: true }).click();
  await expect(page.getByText("Čaká 4 záznamov · 1 fotografií · 1 príjmov hotovosti", { exact: true })).toBeVisible();
  expect(commands).toHaveLength(0);
  await boot();
  await expect(page.getByRole("textbox", { name: "Poznámka k výkonu", exact: true })).toHaveValue("Práca uložená bez signálu.");
  await expect(page.getByText("Čaká 4 záznamov · 1 fotografií · 1 príjmov hotovosti", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: ".context/towing-offline-360.png", fullPage: true });
  await page.evaluate(() => { Object.defineProperty(navigator, "onLine", { get: () => true, configurable: true }); dispatchEvent(new Event("online")); });
  await expect(page.getByText("Všetky odoslané záznamy sú potvrdené.", { exact: true })).toBeVisible();
  expect(phases).toEqual(["update_order", "upload", "receive_payment", "submit"]);
  expect(state.orders[0].receivedCents).toBe(2000);
  expect(commands.find(command => command.type === "update_order")?.payload.fields).toEqual({ driverNotes: "Práca uložená bez signálu.", finishedAt: "2026-10-13T11:00:00.000Z" });
  expect(state.orders[0].fields.startSource).toBe("assignment");
  expect(commands.find(command => command.type === "submit")?.payload.receiptIds).toEqual([commands.find(command => command.type === "receive_payment")?.payload.receiptId]);
});
