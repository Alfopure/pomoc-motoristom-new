import { describe, expect, it } from "vitest";
import type { CallRecordingDetail } from "@/lib/telephony/recording-quality";
import { canShowRecordingContent, playbackTarget, qualityPercent } from "./recording-presentation";

function recording(): Pick<CallRecordingDetail, "access" | "state" | "segments" | "gaps"> {
  return { access: "full", state: "partial", gaps: [{ startSeconds: 20, endSeconds: 35, reason: "gap" }], segments: [
    { id: "a", index: 0, startSeconds: 0, durationSeconds: 20, state: "ready", channels: 2, canPlay: true, error: null },
    { id: "b", index: 1, startSeconds: 35, durationSeconds: 30, state: "ready", channels: 2, canPlay: true, error: null },
  ] };
}

describe("private recording presentation", () => {
  it("maps logical-call evidence to its segment-local timestamp", () => {
    expect(playbackTarget(recording(), 42, "b")?.offsetSeconds).toBe(7);
    expect(playbackTarget(recording(), 42, "a")).toBeNull();
  });
  it("never seeks over a gap or treats the end of a file as captured speech", () => {
    expect(playbackTarget(recording(), 20)).toBeNull();
    expect(playbackTarget(recording(), 34.99)).toBeNull();
    expect(playbackTarget(recording(), 35)?.offsetSeconds).toBe(0);
    expect(playbackTarget(recording(), 65)).toBeNull();
  });
  it.each([NaN, Infinity, -Infinity, -1])("rejects invalid evidence time %s", (time) => {
    expect(playbackTarget(recording(), time)).toBeNull();
  });
  it.each(["restricted", "deleted", "disabled"] as const)("blocks every content surface for %s", (state) => {
    const detail = { ...recording(), state };
    expect(canShowRecordingContent(detail)).toBe(false);
    expect(playbackTarget(detail, 1)).toBeNull();
  });
  it("does not widen own-review access into audio or transcript access", () => {
    expect(canShowRecordingContent({ access: "own_review", state: "ready" })).toBe(false);
    expect(playbackTarget({ ...recording(), access: "own_review" }, 1)).toBeNull();
  });
  it("requires an available playable segment even if the time exists", () => {
    const detail = recording(); detail.segments[0].canPlay = false;
    expect(playbackTarget(detail, 1)).toBeNull();
    detail.segments[0].canPlay = true; detail.segments[0].state = "failed";
    expect(playbackTarget(detail, 1)).toBeNull();
  });
  it("does not display unknown or malformed proportions as a measured zero", () => {
    expect(qualityPercent(null)).toBe("—"); expect(qualityPercent(NaN)).toBe("—");
    expect(qualityPercent(80)).toBe("—"); expect(qualityPercent(-0.1)).toBe("—");
    expect(qualityPercent(0)).toBe("0 %"); expect(qualityPercent(0.8)).toBe("80 %");
  });
});
