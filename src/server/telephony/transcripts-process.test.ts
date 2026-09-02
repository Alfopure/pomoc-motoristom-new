import { describe, expect, it } from "vitest";

import type { ScribeWord } from "@/lib/integrations/asr/scribe-client";

import { buildSpeakerSegments, classifyCandidate, resolveProcessLimits, speakerAttributionConfidence } from "./transcripts-process";

function word(text: string, speaker: string, start: number, end?: number): ScribeWord {
  return { type: "word", text, speaker_id: speaker, start, end: end ?? start + 0.4 };
}

const twoPartyWords: ScribeWord[] = [
  word("Pomoc", "speaker_0", 0),
  word("motoristom", "speaker_0", 0.5),
  word("dobrý", "speaker_0", 1),
  word("deň", "speaker_0", 1.5),
  word("Dobrý", "speaker_1", 2.2),
  word("deň", "speaker_1", 2.7),
  word("pokazilo", "speaker_1", 3.2),
  word("sa", "speaker_1", 3.6),
  word("mi", "speaker_1", 3.9),
  word("auto", "speaker_1", 4.2),
  word("Kde", "speaker_0", 5),
  word("sa", "speaker_0", 5.3),
  word("nachádzate", "speaker_0", 5.6),
];

describe("buildSpeakerSegments", () => {
  it("groups consecutive words per speaker and maps inbound first speaker to dispecer", () => {
    const segments = buildSpeakerSegments(twoPartyWords, "inbound");

    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ speaker: "dispecer", text: "Pomoc motoristom dobrý deň", start: 0 });
    expect(segments[1]).toMatchObject({ speaker: "volajuci" });
    expect(segments[1].text).toContain("pokazilo sa mi auto");
    expect(segments[2].speaker).toBe("dispecer");
  });

  it("maps outbound first speaker to volajuci", () => {
    const segments = buildSpeakerSegments(twoPartyWords, "outbound");
    expect(segments[0].speaker).toBe("volajuci");
    expect(segments[1].speaker).toBe("dispecer");
  });

  it("splits on silence gaps over 2.5s within the same speaker", () => {
    const words = [word("prvá", "speaker_0", 0), word("veta", "speaker_0", 0.5), word("druhá", "speaker_0", 5), word("veta", "speaker_0", 5.5)];
    const segments = buildSpeakerSegments(words, "inbound");
    expect(segments).toHaveLength(2);
  });

  it("keeps raw labels for 3+ speakers", () => {
    const words = [word("a", "speaker_0", 0), word("b", "speaker_1", 1), word("c", "speaker_2", 2)];
    const segments = buildSpeakerSegments(words, "inbound");
    expect(segments.map((segment) => segment.speaker)).toEqual(["speaker_0", "speaker_1", "speaker_2"]);
  });

  it("ignores non-word events and returns [] when empty", () => {
    expect(buildSpeakerSegments([{ type: "audio_event", text: "(zvonenie)" }], "inbound")).toEqual([]);
  });
});

describe("speakerAttributionConfidence", () => {
  it("is high for a balanced two-party call with alternations", () => {
    const segments = buildSpeakerSegments(twoPartyWords, "inbound");
    expect(speakerAttributionConfidence(segments, twoPartyWords)).toBeGreaterThanOrEqual(0.9);
  });

  it("is low when only one speaker was detected", () => {
    const words = Array.from({ length: 20 }, (_, index) => word(`slovo${index}`, "speaker_0", index));
    const segments = buildSpeakerSegments(words, "inbound");
    expect(speakerAttributionConfidence(segments, words)).toBeLessThan(0.9);
  });

  it("is low when the minority speaker barely talks", () => {
    const words = [
      ...Array.from({ length: 39 }, (_, index) => word(`slovo${index}`, "speaker_0", index)),
      word("hm", "speaker_1", 40),
    ];
    const segments = buildSpeakerSegments(words, "inbound");
    expect(speakerAttributionConfidence(segments, words)).toBeLessThan(0.9);
  });
});

describe("classifyCandidate", () => {
  const base = { status: "failed", extracted_fields: {}, updated_at: new Date().toISOString() } as never;

  it("creates when no transcript exists", () => {
    expect(classifyCandidate(undefined)).toBe("create");
  });

  it("skips complete transcripts", () => {
    expect(classifyCandidate({ ...(base as object), status: "complete" } as never)).toBe("skip");
  });

  it("retries failed transcripts under the retry cap", () => {
    expect(classifyCandidate({ ...(base as object), status: "failed", extracted_fields: { retry_count: 1 } } as never)).toBe("retry");
  });

  it("skips failed transcripts at the retry cap", () => {
    expect(classifyCandidate({ ...(base as object), status: "failed", extracted_fields: { retry_count: 3 } } as never)).toBe("skip");
  });

  it("skips a fresh processing lease and reclaims a stale one", () => {
    expect(classifyCandidate({ ...(base as object), status: "processing", updated_at: new Date().toISOString() } as never)).toBe("skip");
    expect(
      classifyCandidate({
        ...(base as object),
        status: "processing",
        updated_at: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
      } as never),
    ).toBe("reclaim");
  });
});

describe("resolveProcessLimits", () => {
  it("preserves the default transcript and AI batch sizes", () => {
    expect(resolveProcessLimits()).toEqual({ transcriptItems: 3, aiItems: 5 });
  });

  it("applies an explicit maxItems limit to subsequent AI analysis", () => {
    expect(resolveProcessLimits(1)).toEqual({ transcriptItems: 1, aiItems: 1 });
  });
});
