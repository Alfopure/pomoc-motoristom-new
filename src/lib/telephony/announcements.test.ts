import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENT_DEFINITIONS, ANNOUNCEMENT_LANGUAGES, ANNOUNCEMENT_VOICES,
  DEFAULT_ANNOUNCEMENT_TEXTS, defaultAnnouncementConfig, readAnnouncementConfig, resolveAnnouncement,
} from "./announcements";

describe("caller announcement assets", () => {
  it("ships the exact configured text and intact audio in all four languages", () => {
    const manifest = JSON.parse(readFileSync(resolve("public/telephony/announcements-v1/manifest.json"), "utf8")) as Array<{ file: string; language: string; key: string; text: string; sha256: string; durationSeconds: number }>;
    for (const { code } of ANNOUNCEMENT_LANGUAGES) for (const { key } of ANNOUNCEMENT_DEFINITIONS) {
      const prompt = resolveAnnouncement(defaultAnnouncementConfig(), key, code);
      const entry = manifest.find((item) => item.key === key && item.language === code)!;
      expect(entry, `${code}/${key}`).toBeDefined();
      expect(entry.text).toBe(DEFAULT_ANNOUNCEMENT_TEXTS[code][key]);
      expect(entry.file).toBe(prompt.file);
      expect(createHash("sha256").update(readFileSync(resolve("public/telephony", entry.file))).digest("hex")).toBe(entry.sha256);
      expect(entry.durationSeconds).toBeGreaterThan(1);
      expect(entry.durationSeconds).toBeLessThan(16);
    }
    const greeting = manifest.find((item) => item.key === "greeting" && item.language === "sk")!;
    expect(greeting.durationSeconds).toBeLessThan(3.5);
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
