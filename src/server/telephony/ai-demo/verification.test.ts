import { describe, expect, it } from "vitest";

import type { CallerCase } from "./caller-case";
import type { TranscriptEntry } from "./greeting";
import { PlateGate } from "./verification";

const FOUND: CallerCase = {
  before: { caseId: "case", caseNumber: "2026-0042", status: "in_progress", openedOn: "2026-09-12" },
  plateOnFile: "BL123AB",
  after: { contactName: "Jana Nováková", vehicle: "Škoda Octavia", summary: "Porucha", mainNote: "Čaká" },
};

const said = (text: string): TranscriptEntry => ({ ms: 0, dir: "in", text });
const heard = (text: string): TranscriptEntry => ({ ms: 0, dir: "out", text });

describe("PlateGate", () => {
  it("stays shut until the right plate is said", () => {
    const gate = new PlateGate(FOUND, false, 0);
    expect(gate.observe([said("dobrý deň, volám kvôli autu")]).instruction).toBeNull();
    expect(gate.current).toBe("waiting");
  });

  it("opens on the plate and hands over the permitted sentence", () => {
    const gate = new PlateGate(FOUND, false, 0);
    const outcome = gate.observe([said("je to BL 123 AB")]);
    expect(outcome.state).toBe("verified");
    expect(outcome.instruction).toContain("2026-0042");
    expect(outcome.instruction).not.toContain("BL123AB");
  });

  it("gives the rest only when disclosure is on", () => {
    expect(new PlateGate(FOUND, true, 0).observe([said("BL123AB")]).instruction).toContain("Jana Nováková");
    expect(new PlateGate(FOUND, false, 0).observe([said("BL123AB")]).instruction).not.toContain("Jana");
  });

  it("ignores what she says herself, so she cannot verify on the caller's behalf", () => {
    const gate = new PlateGate(FOUND, false, 0);
    expect(gate.observe([heard("máte BL 123 AB, však?")]).state).toBe("waiting");
  });

  it("does not spend an attempt on politeness", () => {
    const gate = new PlateGate(FOUND, false, 0);
    const heardSoFar: TranscriptEntry[] = [];
    for (const word of ["áno", "prosím", "moment", "neviem", "počkajte", "dobrý deň", "hneď to nájdem"]) { heardSoFar.push(said(word)); gate.observe(heardSoFar); }
    expect(gate.attemptsUsed).toBe(0);
  });

  it("spends an attempt on a real wrong answer", () => {
    const gate = new PlateGate(FOUND, false, 0);
    expect(gate.observe([said("KE 456 CD")]).attemptSpent).toBe(true);
    expect(gate.attemptsUsed).toBe(1);
  });

  it("stops answering after three wrong ones and says why without saying more", () => {
    const gate = new PlateGate(FOUND, false, 0);
    // The probe hands over the whole transcript each time, so the test does too.
    const heardSoFar = [said("KE 456 CD")];
    gate.observe(heardSoFar);
    heardSoFar.push(said("TT 111 AA"));
    gate.observe(heardSoFar);
    heardSoFar.push(said("ZA 222 BB"));
    const last = gate.observe(heardSoFar);
    expect(last.state).toBe("exhausted");
    expect(last.instruction).toContain("ozve kolega");
    expect(last.instruction).not.toContain("2026-0042");
  });

  it("counts attempts already spent on earlier calls today", () => {
    // Redialling used to reset the counter, which made it an unlimited oracle.
    const gate = new PlateGate(FOUND, false, 2);
    expect(gate.observe([said("KE 456 CD")]).state).toBe("exhausted");
  });

  it("is already shut when the day's attempts are gone", () => {
    const gate = new PlateGate(FOUND, false, 3);
    expect(gate.current).toBe("exhausted");
    expect(gate.observe([said("BL123AB")]).instruction).toBeNull();
  });

  it("cannot be opened at all when the case has no plate on file", () => {
    const gate = new PlateGate({ ...FOUND, plateOnFile: null }, false, 0);
    expect(gate.current).toBe("exhausted");
    expect(gate.observe([said("BL123AB")]).state).toBe("exhausted");
  });

  it("counts one attempt per utterance even when several arrive at once", () => {
    const gate = new PlateGate(FOUND, false, 0);
    gate.observe([said("KE 456 CD"), said("TT 111 AA")]);
    expect(gate.attemptsUsed).toBe(2);
  });

  it("does not re-examine what it has already seen", () => {
    const gate = new PlateGate(FOUND, false, 0);
    const heardSoFar = [said("KE 456 CD")];
    gate.observe(heardSoFar);
    gate.observe(heardSoFar);
    expect(gate.attemptsUsed).toBe(1);
  });

  it("still counts when it is fed one utterance at a time instead of the whole list", () => {
    const gate = new PlateGate(FOUND, false, 0);
    gate.observe([said("KE 456 CD")]);
    gate.observe([said("TT 111 AA")]);
    expect(gate.attemptsUsed).toBe(2);
  });

  it("stays shut once opened, so a later wrong answer cannot close it", () => {
    const gate = new PlateGate(FOUND, false, 0);
    gate.observe([said("BL123AB")]);
    expect(gate.observe([said("KE 456 CD")]).state).toBe("verified");
  });
});
