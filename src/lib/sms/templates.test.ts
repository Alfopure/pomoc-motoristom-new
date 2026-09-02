import { describe, expect, it } from "vitest";
import { renderEtaUpdateSms, renderLocationRequestSms, renderSmsTemplate } from "./templates";

describe("SMS templates", () => {
  it("renders the public location request with the case number and link", () => {
    expect(
      renderLocationRequestSms({
        brandName: "Pomoc Motoristom",
        caseNumber: "PM-2026-0012",
        link: "https://example.com/l/token",
      }),
    ).toBe(
      "Pomoc Motoristom: Dobry den, prosim poslite nam presnu polohu vozidla k pripadu PM-2026-0012. Otvorte link https://example.com/l/token a povolte zdielanie polohy. Na tuto SMS neodpovedajte.",
    );
  });

  it("renders the ETA update with rounded arrival minutes", () => {
    expect(
      renderSmsTemplate("eta_update", {
        brandName: "Pomoc Motoristom",
        caseNumber: "PM-2026-0012",
        etaMinutes: 18.4,
      }),
    ).toBe("Pomoc Motoristom: Dobry den, technik je na ceste k pripadu PM-2026-0012. Predpokladany prichod je priblizne 18 min. Na tuto SMS neodpovedajte.");
  });

  it("requires ETA minutes for the ETA update", () => {
    expect(() => renderEtaUpdateSms({ caseNumber: "PM-2026-0012" })).toThrow("SMS ETA minutes are required.");
  });
});
