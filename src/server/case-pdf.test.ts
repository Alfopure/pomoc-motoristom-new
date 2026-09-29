import { describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { renderCasePdf, type CasePdfSnapshot } from "./case-pdf-template";

vi.mock("server-only", () => ({}));

function towFixture(): CasePdfSnapshot {
  return {
    case: {
      case_number: "PM-ŽŠČ-001", created_at: "2026-09-10T12:00:00Z", updated_at: "2026-09-10T12:30:00Z",
      case_type: "Odťah + náhradné vozidlo", status: "open", priority: "high",
      customer_details: {
        assistanceServiceName: "Test Asistencia", assistanceReference: "AS-6789",
        contacts: [
          { name: "Vedľajší kontakt", phone: "+421900000002" },
          { name: "Ľuboš Šťastný", phone: "+421900000001", isPrimary: true },
        ],
        note: "Zákazník čaká pri zvodidlách.",
      },
      vehicle_details: { jobTypes: ["tow", "replacement_vehicle"], conditionFlags: ["immobile", "blocked_wheel"], note: "Pozor na prevodovku." },
      incident_details: { type: "breakdown", description: "Zablokované koleso", damages: "Ľavý blatník" },
      location_details: { manualPickupAddress: "D1, smer Žilina, 42. km", roadName: "D1", kilometerSection: "42", drivingDirection: "Žilina", placeType: "highway", complications: "Použiť výstražné svetlá", destinationNote: "Odovzdať v servise" },
      replacement_vehicle_details: { needed: true, requestedType: "SUV", maxDays: 4, entitlement: "yes", extensionPossible: true, deliveryPlace: "Pobočka Žilina", note: "Limit pristavenia 50 km alebo 100 €." },
      payment_details: { method: "insurance", status: "unpaid" },
      summary: "Porucha na diaľnici", main_note: 'Kľúče u klienta. <img src="https://example.invalid/track"> <script>alert(1)</script>',
    },
    snapshotAt: "2026-09-10T12:30:01Z",
    assignedAsset: { label: "Odťahovka č. 4", license_plate: "BB456XY", assignedDriverName: "Ján Vodič", assignedDriverPhone: "+421900000003" },
    contact: { name: "Záložný kontakt", phone: "+421900000004", raw_payload: "MUST_NOT_EXPORT" },
    vehicle: { license_plate: "BA123XY", vin: "TMBJG7NE0J0123456", make: "Škoda", model: "Octavia", is_driveable: false },
    pickup: { address: "Stará adresa mapy" }, destination: { address: "Servis Ružomberok" },
    tasks: [{ title: "Overiť príjazd" }],
    events: [{ title: "PRIVATE_EVENT", body: "PRIVATE_EVENT_BODY" }],
    sms: [{ body: "PRIVATE_SMS" }],
  };
}

function rentalFixture(): CasePdfSnapshot {
  const snapshot = towFixture();
  return {
    ...snapshot,
    case: {
      ...snapshot.case,
      case_type: "Náhradné vozidlo",
      main_note: "Vodič má zavolať klientovi pri pristavení.",
      vehicle_details: { jobTypes: ["replacement_vehicle"] },
      replacement_vehicle_details: {
        needed: true, requestedType: "Kombi", maxDays: 3, entitlement: "yes",
        extensionPossible: false, deliveryPlace: "Letisko Bratislava", note: "Limit pristavenia 50 km.",
      },
    },
    assignedAsset: { kind: "replacement_car", label: "Náhradné vozidlo č. 2", license_plate: "BA987CD", assignedDriverName: "Mária Vodička" },
  };
}

describe("one-page case brief template", () => {
  it("shows the saved tow and rental instructions, main contact, and assistance reference", () => {
    const html = renderCasePdf(towFixture(), "FONT", "BOLD");
    for (const value of ["AS-6789", "Ľuboš Šťastný", "BA123XY", "TMBJG7NE0J0123456", "D1, smer Žilina, 42. km", "Servis Ružomberok", "Zablokované koleso", "Nepojazdné", "Pobočka Žilina", "4 dní", "Limit pristavenia 50 km alebo 100 €.", "Ján Vodič"]) {
      expect(html).toContain(value);
    }
    expect(html).toContain("Založené");
    expect(html).toContain("10. 9. 2026");
    expect(html).not.toContain("Vedľajší kontakt");
    expect(html).not.toContain("Záložný kontakt");
    expect(html).not.toContain("Stará adresa mapy");
    expect(html).not.toContain("PRIVATE_EVENT");
    expect(html).not.toContain("PRIVATE_SMS");
    expect(html).not.toContain("Overiť príjazd");
    expect(html).not.toContain("MUST_NOT_EXPORT");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("data:font/ttf;base64,FONT");
  });

  it("omits towing, incident and driveability details for rental-only work", () => {
    const html = renderCasePdf(rentalFixture(), "", "");
    for (const value of ["Náhradné vozidlo", "Kombi", "Letisko Bratislava", "Limit pristavenia 50 km.", "Predĺženie", "Nie"]) {
      expect(html).toContain(value);
    }
    for (const value of ["Trasa odťahu", "Cieľ odťahu", "Miesto zásahu", "Zásah</h2>", "Zablokované koleso", "Nepojazdné", "Ľavý blatník", "Servis Ružomberok", "D1, smer Žilina", "Porucha na diaľnici", "Pozor na prevodovku."]) {
      expect(html).not.toContain(value);
    }
  });

  it("includes a requested replacement in a towing job even when its job type was not selected", () => {
    const snapshot = towFixture();
    snapshot.case.vehicle_details = { jobTypes: ["tow"], conditionFlags: ["immobile"] };
    const html = renderCasePdf(snapshot, "", "");
    expect(html).toContain("Odťah · Náhradné vozidlo");
    expect(html).toContain("Trasa odťahu");
    expect(html).toContain("Pobočka Žilina");
    expect(html).toContain("Limit pristavenia 50 km alebo 100 €.");
  });

  it("does not print stale replacement details after the operator marks it unnecessary", () => {
    const snapshot = towFixture();
    snapshot.case.replacement_vehicle_details = { ...snapshot.case.replacement_vehicle_details as Record<string, unknown>, needed: false };
    const html = renderCasePdf(snapshot, "", "");
    expect(html).toContain("Nie, zákazník nepotrebuje");
    expect(html).not.toContain("Pobočka Žilina");
    expect(html).not.toContain("4 dní");
    expect(html).not.toContain("Limit pristavenia 50 km");
  });

  it("keeps the customer identity, primary phone and explicit driveability distinct", () => {
    const snapshot = towFixture();
    snapshot.case.customer_details = {
      companyName: "ABC servis s.r.o.", alternativeContact: "+421900000099",
      contacts: [{ name: "Ján Kontakt", isPrimary: true }],
    };
    snapshot.contact = { name: "Iný kontakt", phone: "+421900000088" };
    snapshot.case.vehicle_details = { jobTypes: ["tow"], conditionFlags: ["locked"] };
    snapshot.case.summary = "Odťah + náhradné vozidlo · BA123XY";
    const html = renderCasePdf(snapshot, "", "");
    expect(html).toContain("ABC servis s.r.o.");
    expect(html).toContain("Ján Kontakt");
    expect(html).toContain("Nepojazdné · Zamknuté");
    expect(html).not.toContain("+421900000099");
    expect(html).not.toContain("+421900000088");
    expect(html).not.toContain("<dt>Stručný opis</dt>");
  });

  it("keeps sparse legacy cases readable without empty sections", () => {
    const snapshot: CasePdfSnapshot = {
      case: { case_number: "PM-002", updated_at: "2026-09-10T12:00:00Z", case_type: "Odťah", assistance_reference: "OLD-123", location_details: { manualDestinationAddress: "Manuálny servis" } },
      vehicle: { license_plate: "KE123AB" }, destination: { address: "Stará mapová adresa" },
      tasks: [], events: [], sms: [],
    };
    const html = renderCasePdf(snapshot, "", "");
    expect(html).toContain("Odťah");
    expect(html).toContain("OLD-123");
    expect(html).toContain("Manuálny servis");
    expect(html).not.toContain("Stará mapová adresa");
    expect(html).not.toContain("Neuvedené");
    expect(html).not.toContain("Žiadne záznamy");
    expect(html).not.toContain("<h2>Poznámky</h2>");
  });

  it("marks shortened long notes rather than silently clipping them", () => {
    const snapshot = towFixture();
    snapshot.case.main_note = "Dôležitý pokyn pre vodiča. ".repeat(60);
    const html = renderCasePdf(snapshot, "", "");
    expect(html).toContain("…*");
    expect(html).toContain("* Skrátené. Úplné znenie je v karte prípadu.");
    expect(html).not.toContain("Dôležitý pokyn pre vodiča. ".repeat(60));
    expect(html).not.toContain("overflow:hidden");
  });

  it("preserves line breaks in operational notes", () => {
    const snapshot = towFixture();
    snapshot.case.main_note = "Najprv zavolať.\nPotom pristaviť vozidlo.";
    const html = renderCasePdf(snapshot, "", "");
    expect(html).toContain("Najprv zavolať.\nPotom pristaviť vozidlo.");
  });
});

describe.skipIf(process.env.CASE_PDF_INTEGRATION !== "1")("real bundled Chromium export", () => {
  it("exports tow, rental-only and dense briefings on one A4 page with extractable Slovak text", async () => {
    const { generateCasePdf } = await import("./case-pdf");
    const tow = towFixture();
    tow.case.main_note = "Vodič má zavolať klientovi pred príchodom.";
    const dense = towFixture();
    dense.case.main_note = "Dlhší pokyn pre vodiča a odťah. ".repeat(60);
    dense.case.customer_details = { ...dense.case.customer_details as Record<string, unknown>, note: "Zákazník čaká pri ceste. ".repeat(40) };
    dense.case.summary = "Zhrnutie situácie na mieste. ".repeat(30);
    dense.case.incident_details = { ...dense.case.incident_details as Record<string, unknown>, description: "Neštandardný problém s vozidlom. ".repeat(25), damages: "Poškodené diely vozidla. ".repeat(25) };
    dense.case.location_details = { ...dense.case.location_details as Record<string, unknown>, manualPickupAddress: "Miesto na diaľnici D1 pri výjazde. ".repeat(6) + "BRANA-12", manualDestinationAddress: "Cieľový servis s dohodnutým príjmom. ".repeat(6) + "PRIJEM-B", complications: "Ťažký prístup k vozidlu. ".repeat(20), destinationNote: "Pred odovzdaním zavolať. ".repeat(20) };
    dense.case.replacement_vehicle_details = { ...dense.case.replacement_vehicle_details as Record<string, unknown>, deliveryPlace: "Miesto pristavenia náhradného vozidla. ".repeat(6) + "PARKOVISKO-3", note: "Limit, špeciálne požiadavky a čas pristavenia. ".repeat(25) };
    dense.case.vehicle_details = { ...dense.case.vehicle_details as Record<string, unknown>, note: "Opatrne pri manipulácii s vozidlom. ".repeat(25) };
    dense.events = Array.from({ length: 140 }, (_, index) => ({ title: `Udalosť ${index}` }));
    for (const [name, snapshot, expected] of [
      ["tow", tow, "Ľuboš Šťastný"],
      ["rental", rentalFixture(), "Letisko Bratislava"],
      ["dense", dense, "Skrátené"],
    ] as const) {
      const pdf = await generateCasePdf(snapshot);
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      const path = `.context/case-pdf-${name}.pdf`;
      await writeFile(path, pdf);
      const info = execFileSync("pdfinfo", [path], { encoding: "utf8" });
      expect(info.match(/Pages:\s+(\d+)/)?.[1]).toBe("1");
      expect(info).toContain("A4");
      execFileSync("pdftotext", [path, `.context/case-pdf-${name}.txt`]);
      const extracted = await readFile(`.context/case-pdf-${name}.txt`, "utf8");
      expect(extracted).toContain(expected);
      if (name === "dense") {
        expect(extracted).toContain("BRANA-12");
        expect(extracted).toContain("PRIJEM-B");
        expect(extracted).toContain("PARKOVISKO-3");
      }
      expect(extracted).not.toContain("PRIVATE_SMS");
      expect(extracted).not.toContain("Udalosť 139");
    }
  }, 120_000);
});
