import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENT_CATEGORIES, ANNOUNCEMENT_DEFINITIONS, ANNOUNCEMENT_LANGUAGES, ANNOUNCEMENT_VOICES,
  DEFAULT_ANNOUNCEMENT_TEXTS, defaultAnnouncementConfig, readAnnouncementConfig, resolveAnnouncement,
} from "./announcements";

describe("caller announcement assets", () => {
  it("ships the exact configured text and intact audio in all four languages", () => {
    const manifest = JSON.parse(readFileSync(resolve("public/telephony/announcements-v2/manifest.json"), "utf8")) as Array<{ file: string; language: string; key: string; text: string; sha256: string; durationSeconds: number; runtimeStatus: string }>;
    expect(manifest).toHaveLength(101);
    for (const { code } of ANNOUNCEMENT_LANGUAGES) for (const { key, runtimeStatus } of ANNOUNCEMENT_DEFINITIONS) {
      const prompt = resolveAnnouncement(defaultAnnouncementConfig(), key, code);
      const entry = manifest.find((item) => item.key === key && item.language === code)!;
      expect(entry, `${code}/${key}`).toBeDefined();
      expect(entry.text).toBe(DEFAULT_ANNOUNCEMENT_TEXTS[code][key]);
      expect(entry.runtimeStatus).toBe(runtimeStatus);
      expect(entry.file).toBe(prompt.file);
      expect(createHash("sha256").update(readFileSync(resolve("public/telephony", entry.file))).digest("hex")).toBe(entry.sha256);
      expect(entry.durationSeconds).toBeGreaterThan(1);
      expect(entry.durationSeconds).toBeLessThan(16);
    }
    const greeting = manifest.find((item) => item.key === "greeting" && item.language === "sk")!;
    expect(greeting.durationSeconds).toBeLessThan(3.5);
    const music = manifest.find((item) => item.key === "moh")!;
    expect(createHash("sha256").update(readFileSync(resolve("public/telephony", music.file))).digest("hex")).toBe(music.sha256);
  });
  it("marks implemented call situations active while retaining unused alternatives as prepared", () => {
    expect(ANNOUNCEMENT_DEFINITIONS).toHaveLength(25);
    expect(new Set(ANNOUNCEMENT_DEFINITIONS.map(({ key }) => key)).size).toBe(25);
    expect(ANNOUNCEMENT_DEFINITIONS.filter(({ runtimeStatus }) => runtimeStatus === "active").map(({ key }) => key)).toEqual([
      "greeting", "afterHours", "ivrMain", "callbackOffer", "callbackConfirmed", "allBusy", "invalidInput",
      "holdStart", "resume", "transferStart", "consultStart", "parkStart", "conferenceJoin", "conferenceLeave", "outboundIntro", "recordingServiceNotice", "recordingNotice", "recordingPaused", "recordingResumed",
    ]);
    expect(ANNOUNCEMENT_DEFINITIONS.filter(({ runtimeStatus }) => runtimeStatus === "prepared")).toHaveLength(6);
    expect(ANNOUNCEMENT_CATEGORIES.map(({ key }) => ANNOUNCEMENT_DEFINITIONS.filter((definition) => definition.category === key).length)).toEqual([7, 3, 6, 4, 5]);
    expect(resolveAnnouncement(defaultAnnouncementConfig(), "greeting").file).toBe("announcements-v1/sk/greeting.mp3");
    expect(resolveAnnouncement(defaultAnnouncementConfig(), "recordingNotice").file).toBe("announcements-v2/sk/recordingNotice.mp3");
  });
  it("preserves custom prompt drafts without changing the independent recording configuration", () => {
    const config = readAnnouncementConfig({ ...defaultAnnouncementConfig(), prompts: { de: { transferStart: { text: "Wir verbinden Sie jetzt." } }, sk: { recordingNotice: { text: "Vlastný návrh oznámenia." } } } });
    expect(resolveAnnouncement(config, "transferStart", "de")).toMatchObject({ text: "Wir verbinden Sie jetzt.", audioUrl: null });
    expect(resolveAnnouncement(config, "recordingNotice")).toMatchObject({ text: "Vlastný návrh oznámenia.", audioUrl: null });
    expect(config).not.toHaveProperty("recordingEnabled");
  });
  it("uses speech rather than stale generated audio after a voice changes", () => {
    const config = defaultAnnouncementConfig();
    config.prompts.sk = { greeting: { text: "Vitajte na našej linke.", audioUrl: "https://media.test/generated.mp3", voiceId: config.voiceId } };
    expect(resolveAnnouncement(config, "greeting").file).toBe("https://media.test/generated.mp3");
    config.voiceId = ANNOUNCEMENT_VOICES[1].id;
    expect(resolveAnnouncement(config, "greeting")).toMatchObject({ file: null, audioUrl: null, text: "Vitajte na našej linke.", voice: "Azure.sk-SK-LukasNeural" });
  });
  it("safely defaults old or malformed stored configuration and discards invalid prompts", () => {
    for (const value of [null, [], { version: 999 }, { version: 1, language: "xx", voiceId: "wrong" }]) {
      expect(readAnnouncementConfig(value)).toEqual(defaultAnnouncementConfig());
    }
    const config = readAnnouncementConfig({ ...defaultAnnouncementConfig(), prompts: { sk: { greeting: { text: "" }, callbackOffer: { text: "Spätné volanie.", audioUrl: "javascript:alert(1)" } } } });
    expect(config.prompts.sk?.greeting).toBeUndefined();
    expect(config.prompts.sk?.callbackOffer).toEqual({ text: "Spätné volanie." });
  });
});
