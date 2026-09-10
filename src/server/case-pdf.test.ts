import { describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { renderCasePdf, type CasePdfSnapshot } from "./case-pdf-template";

vi.mock("server-only", () => ({}));

function fixture(events = 2): CasePdfSnapshot {
  return {
    case: { case_number: "PM-ŽŠČ-001", status: "open", priority: "high", updated_at: "2026-09-10T12:00:00Z", customer_details: { firstName: "Ľuboš", lastName: "Šťastný" }, summary: "Ťažné zariadenie, nepojazdné vozidlo. Žĺtok a kôň." },
    snapshotAt: "2026-09-10T12:00:01.123456Z", assignedAsset: { label: "Odťahovka č. 4", license_plate: "BB456XY", assignedDriverName: "Ján Vodič" },
    owner: "Dispečer Ľuboš", contact: { name: "Ľuboš Šťastný", phone: "+421900000001", notes: '<img src="https://example.invalid/track"> <script>alert(1)</script>', raw_payload: "MUST_NOT_EXPORT" },
    vehicle: { license_plate: "BA123XY", make: "Škoda" }, tasks: [{ title: "Overiť príjazd", status: "open" }],
    events: Array.from({ length: events }, (_, index) => ({ title: `Udalosť ${index + 1}`, body: "Úplný záznam zásahu so slovenskou diakritikou. ".repeat(12), actor: "Test", createdAt: "2026-09-10T12:00:00Z" })),
    sms: [{ body: "Dobrý deň, vodič je na ceste. KONIEC SMS", direction: "outbound", status: "delivered" }],
  };
}

describe("saved case PDF template", () => {
  it("escapes case text and excludes raw payload, notebook and chat fields", () => {
    const snapshot = { ...fixture(), notebook: "PRIVATE_NOTE", chat: "PRIVATE_CHAT" };
    const html = renderCasePdf(snapshot, "", "");
    expect(html).toContain("Ľuboš Šťastný");
    expect(html).toContain("Odťahovka č. 4");
    expect(html).toContain("Ján Vodič");
    expect(html).toContain("2026-09-10T12:00:01.123456Z");
    expect(html).toContain("Revízia prípadu: 2026-09-10T12:00:00Z");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("MUST_NOT_EXPORT");
    expect(html).not.toContain("PRIVATE_NOTE");
    expect(html).not.toContain("PRIVATE_CHAT");
    expect(html.match(/<h2>História SMS prípadu<\/h2>/g)).toHaveLength(1);
    expect(html.indexOf("História SMS prípadu")).toBeGreaterThan(html.indexOf("Poznámky a aktivita"));
  });
  it("renders all long text without clipping or external assets", () => {
    const html = renderCasePdf(fixture(200), "FONT", "BOLD");
    expect(html).toContain("Udalosť 200");
    expect(html).toContain("KONIEC SMS");
    expect(html).toContain("data:font/ttf;base64,FONT");
    expect(html).not.toContain("overflow:hidden");
  });
});

describe.skipIf(process.env.CASE_PDF_INTEGRATION !== "1")("real bundled Chromium export", () => {
  it("exports a long A4 file with embedded fonts, extractable Slovak text and page numbers", async () => {
    const { generateCasePdf } = await import("./case-pdf");
    const started = Date.now();
    const pdf = await generateCasePdf(fixture(140));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    await writeFile(".context/case-pdf-long.pdf", pdf);
    const info = execFileSync("pdfinfo", [".context/case-pdf-long.pdf"], { encoding: "utf8" });
    const pages = Number(info.match(/Pages:\s+(\d+)/)?.[1]);
    expect(pages).toBeGreaterThanOrEqual(30);
    expect(info).toContain("A4");
    execFileSync("pdftotext", [".context/case-pdf-long.pdf", ".context/case-pdf-long.txt"]);
    const text = await readFile(".context/case-pdf-long.txt", "utf8");
    expect(text).toContain("Ľuboš Šťastný");
    expect(text).toContain("Udalosť 140");
    expect(text).toContain("KONIEC SMS");
    expect(text).not.toContain("MUST_NOT_EXPORT");
    expect(text.match(/História SMS prípadu/g)).toHaveLength(1);
    await writeFile(".context/case-pdf-runtime.json", JSON.stringify({ pages, bytes: pdf.length, durationMs: Date.now() - started, browser: "bundled @sparticuz/chromium", remoteRequests: 0 }, null, 2));
  }, 60_000);
});
