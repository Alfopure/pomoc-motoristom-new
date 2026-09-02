import { describe, expect, it } from "vitest";

import { clampScore, renderTranscript } from "./call-analysis";

describe("renderTranscript", () => {
  it("renders segments with timestamps and Slovak role labels", () => {
    const rendered = renderTranscript(
      [
        { speaker: "dispecer", speakerId: "speaker_0", start: 0, end: 2, text: "Pomoc motoristom, dobrý deň." },
        { speaker: "volajuci", speakerId: "speaker_1", start: 65, end: 70, text: "Pokazilo sa mi auto." },
        { speaker: "speaker_2", speakerId: "speaker_2", start: 80, end: 82, text: "Haló?" },
      ],
      "fallback",
    );

    expect(rendered).toBe(
      "[0:00] Dispečer: Pomoc motoristom, dobrý deň.\n[1:05] Volajúci: Pokazilo sa mi auto.\n[1:20] speaker_2: Haló?",
    );
  });

  it("falls back to plain text without segments", () => {
    expect(renderTranscript([], "plain text")).toBe("plain text");
  });
});

describe("clampScore", () => {
  it("clamps to 0-100 and rounds", () => {
    expect(clampScore(105)).toBe(100);
    expect(clampScore(-3)).toBe(0);
    expect(clampScore(87.6)).toBe(88);
  });

  it("returns null for non-numbers", () => {
    expect(clampScore(null)).toBeNull();
    expect(clampScore(undefined)).toBeNull();
    expect(clampScore(Number.NaN)).toBeNull();
  });
});
