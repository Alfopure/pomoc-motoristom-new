import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import chromium from "@sparticuz/chromium";
import { chromium as playwright, type Browser } from "playwright-core";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { MotoristActor } from "./api-auth";
import { MutationError } from "./mutation-error";
import { renderCasePdf, type CasePdfSnapshot } from "./case-pdf-template";

export async function loadCasePdfSnapshot(actor: MotoristActor, caseId: string): Promise<CasePdfSnapshot> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(caseId)) throw new MutationError("Neplatný prípad.", 400);
  const client = createSupabaseAdminClient();
  const result = await client.rpc("motorist_case_pdf_snapshot", { p_organization_id: actor.organizationId, p_actor_id: actor.profileId, p_case_id: caseId });
  if (result.error) {
    const status = result.error.code === "P0002" ? 404 : result.error.code === "42501" ? 403 : 503;
    throw new MutationError(status === 403 || status === 404 ? "Prípad nie je dostupný." : "Export PDF momentálne nie je dostupný. Skúste to znova.", status);
  }
  const snapshot = result.data as unknown as CasePdfSnapshot;
  if (!snapshot?.case?.case_number || !Array.isArray(snapshot.events) || !Array.isArray(snapshot.sms) || !Array.isArray(snapshot.tasks)) throw new MutationError("Údaje exportu nie sú úplné.", 503);
  if (JSON.stringify(snapshot).length > 4_000_000) throw new MutationError("Prípad je príliš veľký na jeden export.", 413);
  return snapshot;
}

export async function generateCasePdf(snapshot: CasePdfSnapshot): Promise<Buffer> {
  const started = Date.now();
  let browser: Browser | undefined;
  let expired = false;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= browser?.close().catch(() => {});
  let deadline: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    deadline = setTimeout(() => { expired = true; void close(); reject(new Error("PDF deadline reached")); }, 40_000);
  });
  const render = async () => {
    const [regular, bold, executablePath] = await Promise.all([
      readFile(path.join(process.cwd(), "src/assets/pdf-fonts/LiberationSans-Regular.ttf")),
      readFile(path.join(process.cwd(), "src/assets/pdf-fonts/LiberationSans-Bold.ttf")),
      process.env.CASE_PDF_CHROME_PATH || chromium.executablePath(),
    ]);
    if (expired) throw new Error("PDF deadline reached");
    browser = await playwright.launch({ executablePath, args: process.env.CASE_PDF_CHROME_PATH ? ["--no-sandbox"] : chromium.args, headless: true, timeout: 10_000 });
    if (expired) { await close(); throw new Error("PDF deadline reached"); }
    const page = await browser.newPage({ locale: "sk-SK", javaScriptEnabled: false });
    // Case text cannot load remote images, scripts, styles, fonts or tracking URLs.
    await page.route("**/*", route => route.abort());
    await page.setContent(renderCasePdf(snapshot, regular.toString("base64"), bold.toString("base64")), { waitUntil: "load", timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({ format: "A4", printBackground: true, displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: '<div style="font-size:8px;color:#71717a;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' });
    if (expired) throw new Error("PDF deadline reached");
    console.info("case_pdf_generated", { durationMs: Date.now() - started, bytes: pdf.length });
    return pdf;
  };
  try { return await Promise.race([render(), timeout]); }
  finally { clearTimeout(deadline!); await close(); }
}
