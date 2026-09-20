import { describe, expect, it } from "vitest";

import { callIsOver, isFarewell, normalizeForMatch } from "./farewell";

describe("isFarewell", () => {
  it("recognises the ordinary Slovak closings", () => {
    for (const text of [
      "Dobre, tak dovidenia a pekný deň.",
      "Ďakujem za váš čas, dopočutia.",
      "Majte sa pekne!",
      "Všetko dobré, dovidenia.",
    ]) {
      expect(isFarewell(text), text).toBe(true);
    }
  });

  it("is not fooled by diacritics or spacing in a transcript", () => {
    expect(isFarewell("Dovidenia")).toBe(true);
    expect(isFarewell("do  videnia")).toBe(true);
    expect(normalizeForMatch("Pekný deň")).toBe("pekny den");
  });

  it("does not treat ordinary speech as an ending", () => {
    for (const text of [
      "Takže v stredu popoludní, súhlasí?",
      "Ďakujem, a kedy by vám to vyhovovalo?",
      "Rozumiem, počkám.",
    ]) {
      expect(isFarewell(text), text).toBe(false);
    }
  });
});

describe("callIsOver", () => {
  const goodbye = { ms: 60_000, dir: "out" as const, text: "Ďakujem, dovidenia." };

  it("waits for silence after the goodbye", () => {
    // Said goodbye, but the line has only just gone quiet.
    expect(callIsOver({ turns: [goodbye], lastSpeechMs: 60_000, nowMs: 61_000, silenceMs: 4_000 })).toBe(false);
    expect(callIsOver({ turns: [goodbye], lastSpeechMs: 60_000, nowMs: 65_000, silenceMs: 4_000 })).toBe(true);
  });

  it("does not end a call on silence alone", () => {
    // Somebody thinking is not somebody who has hung up.
    const thinking = { ms: 60_000, dir: "out" as const, text: "A kedy by vám to vyhovovalo?" };
    expect(callIsOver({ turns: [thinking], lastSpeechMs: 60_000, nowMs: 90_000, silenceMs: 4_000 })).toBe(false);
  });

  it("does not end a call where the caller spoke after the goodbye", () => {
    // "Ďakujem za váš čas" in the middle of a call is not the end of it.
    const turns = [goodbye, { ms: 62_000, dir: "in" as const, text: "ešte jedna vec" }];
    expect(callIsOver({ turns, lastSpeechMs: 62_000, nowMs: 80_000, silenceMs: 4_000 })).toBe(false);
  });

  it("ignores empty fragments when deciding what was said last", () => {
    const turns = [goodbye, { ms: 61_000, dir: "in" as const, text: "   " }];
    expect(callIsOver({ turns, lastSpeechMs: 60_000, nowMs: 66_000, silenceMs: 4_000 })).toBe(true);
  });

  it("says nothing about a call in which nobody has spoken", () => {
    expect(callIsOver({ turns: [], lastSpeechMs: 0, nowMs: 30_000, silenceMs: 4_000 })).toBe(false);
  });
});
