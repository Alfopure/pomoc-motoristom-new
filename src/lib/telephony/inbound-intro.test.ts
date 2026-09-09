import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ANNOUNCEMENT_LANGUAGES, defaultAnnouncementConfig, resolveAnnouncement, resolveCombinedInboundIntro } from "./announcements";

describe("locally composed inbound introductions", () => {
  it("matches all eight immutable files to the exact configured default text and voice", () => {
    const manifest = JSON.parse(readFileSync("public/telephony/announcements-intro-v1/manifest.json", "utf8")) as Array<{ file: string; text: string; voiceId: string; sha256: string; durationSeconds: number; sourceFiles: Array<{ file: string; sha256: string }> }>;
    expect(manifest).toHaveLength(8);
    for (const { code: language } of ANNOUNCEMENT_LANGUAGES) for (const notice of ["recordingNotice", "recordingServiceNotice"] as const) {
      const config = { ...defaultAnnouncementConfig(), language };
      const combined = resolveCombinedInboundIntro(config, notice)!;
      const asset = manifest.find((entry) => entry.file === combined.file)!;
      expect(asset.text).toBe(`${resolveAnnouncement(config, "greeting").text} ${resolveAnnouncement(config, notice).text}`);
      expect(asset.voiceId).toBe(config.voiceId);
      expect(createHash("sha256").update(readFileSync(`public/telephony/${asset.file}`)).digest("hex")).toBe(asset.sha256);
      expect(asset.durationSeconds).toBeGreaterThan(2);
      for (const source of asset.sourceFiles) expect(createHash("sha256").update(readFileSync(`public/telephony/${source.file}`)).digest("hex")).toBe(source.sha256);
    }
  });

  it.each(["greeting", "recordingServiceNotice"] as const)("retains separate playback for customized %s text or saved audio", (key) => {
    const config = defaultAnnouncementConfig();
    config.prompts.sk = { [key]: { text: "Vlastný schválený text." } };
    expect(resolveCombinedInboundIntro(config, "recordingServiceNotice")).toBeNull();
    config.prompts.sk = { [key]: { text: resolveAnnouncement(defaultAnnouncementConfig(), key).text, audioUrl: "https://example.invalid/approved.mp3", voiceId: config.voiceId } };
    expect(resolveCombinedInboundIntro(config, "recordingServiceNotice")).toBeNull();
  });

  it("retains the selected non-default voice", () => {
    expect(resolveCombinedInboundIntro({ ...defaultAnnouncementConfig(), voiceId: "EXAVITQu4vr4xnSDxMaL" }, "recordingNotice")).toBeNull();
  });
});
