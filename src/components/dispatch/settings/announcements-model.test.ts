import { describe, expect, it } from "vitest";

import { ANNOUNCEMENT_VOICES, defaultAnnouncementConfig, resolveAnnouncement } from "@/lib/telephony/announcements";

import { applyGeneratedAnnouncement, emptyAnnouncementLanguages, resetAnnouncementPrompt, sameAnnouncementConfig, setAnnouncementText } from "./announcements-model";

const initial = defaultAnnouncementConfig();
const expected = { language: "sk" as const, text: "Vitajte na našej linke.", voiceId: initial.voiceId };
const generated = { ...expected, audioUrl: "https://example.test/voice.mp3" };

describe("announcement drafts", () => {
  it("tracks each startup switch as an unsaved change and treats omitted legacy flags as their defaults", () => {
    expect(sameAnnouncementConfig(initial, { ...initial, inboundStartAnnouncements: undefined, outboundStartAnnouncements: undefined })).toBe(true);
    expect(sameAnnouncementConfig(initial, { ...initial, inboundStartAnnouncements: false })).toBe(false);
    expect(sameAnnouncementConfig(initial, { ...initial, outboundStartAnnouncements: true })).toBe(false);
  });
  it("retains direction switches when editing translations, completing generation and resetting a prompt", () => {
    const toggled = { ...initial, inboundStartAnnouncements: false, outboundStartAnnouncements: true };
    const draft = { ...setAnnouncementText(toggled, "sk", "greeting", expected.text), language: "de" as const };
    const completed = applyGeneratedAnnouncement(draft, "greeting", expected, generated)!;
    expect(completed).toMatchObject({ inboundStartAnnouncements: false, outboundStartAnnouncements: true });
    expect(resetAnnouncementPrompt(completed, "sk", "greeting")).toMatchObject({ inboundStartAnnouncements: false, outboundStartAnnouncements: true });
  });
  it("treats status preference changes as dirty and preserves them through text, language and generation edits", () => {
    const enabled = { ...initial, recordingStatusAnnouncements: true };
    expect(sameAnnouncementConfig(initial, enabled)).toBe(false);
    expect(sameAnnouncementConfig(initial, { ...initial, recordingStatusAnnouncements: undefined })).toBe(true);
    const draft = { ...setAnnouncementText(enabled, "sk", "greeting", expected.text), language: "de" as const };
    const completed = applyGeneratedAnnouncement(draft, "greeting", expected, generated)!;
    expect(completed.recordingStatusAnnouncements).toBe(true);
    expect(resetAnnouncementPrompt(completed, "sk", "greeting").recordingStatusAnnouncements).toBe(true);
    expect(sameAnnouncementConfig(initial, { ...initial, recordingStatusAnnouncements: false })).toBe(true);
  });
  it("removes the previous recording when its words are edited and retains other languages", () => {
    const first = setAnnouncementText(initial, "sk", "greeting", expected.text);
    const withAudio = applyGeneratedAnnouncement(first, "greeting", expected, generated)!;
    const withGerman = setAnnouncementText(withAudio, "de", "greeting", "Guten Tag.");
    const changed = setAnnouncementText(withGerman, "sk", "greeting", "Dobrý deň.");
    expect(resolveAnnouncement(changed, "greeting").audioUrl).toBeNull();
    expect(changed.prompts.sk?.greeting).toEqual({ text: "Dobrý deň." });
    expect(changed.prompts.de?.greeting?.text).toBe("Guten Tag.");
    expect(withAudio.prompts.sk?.greeting?.audioUrl).toBe(generated.audioUrl);
  });

  it("rejects an old recording after text or voice changed", () => {
    const changed = setAnnouncementText(initial, "sk", "greeting", "Nové privítanie.");
    expect(applyGeneratedAnnouncement(changed, "greeting", expected, generated)).toBeNull();
    const voiceChanged = { ...setAnnouncementText(initial, "sk", "greeting", expected.text), voiceId: ANNOUNCEMENT_VOICES[1].id };
    expect(applyGeneratedAnnouncement(voiceChanged, "greeting", expected, generated)).toBeNull();
  });

  it("stores a finished recording in its original language while keeping the selected language", () => {
    const changed = { ...setAnnouncementText(initial, "sk", "greeting", expected.text), language: "de" as const };
    const next = applyGeneratedAnnouncement(changed, "greeting", expected, generated)!;
    expect(next.language).toBe("de");
    expect(next.prompts.sk?.greeting?.audioUrl).toBe(generated.audioUrl);
    expect(next.prompts.de).toBeUndefined();
  });

  it("rejects generation responses for different words, language or voice", () => {
    const current = setAnnouncementText(initial, "sk", "greeting", expected.text);
    expect(applyGeneratedAnnouncement(current, "greeting", expected, { ...generated, text: "Iný text." })).toBeNull();
    expect(applyGeneratedAnnouncement(current, "greeting", expected, { ...generated, language: "cs" })).toBeNull();
    expect(applyGeneratedAnnouncement(current, "greeting", expected, { ...generated, voiceId: ANNOUNCEMENT_VOICES[1].id })).toBeNull();
  });

  it("recognizes reset defaults as unchanged despite sparse storage", () => {
    const edited = setAnnouncementText(initial, "sk", "greeting", "Vlastný text.");
    expect(sameAnnouncementConfig(initial, edited)).toBe(false);
    const reset = resetAnnouncementPrompt(edited, "sk", "greeting");
    expect(sameAnnouncementConfig(initial, reset)).toBe(true);
    expect(resolveAnnouncement(reset, "greeting").audioUrl).toMatch(/greeting\.mp3$/);
  });

  it("detects changes to inactive translations and regenerated audio", () => {
    const translated = setAnnouncementText(initial, "de", "greeting", "Guten Tag.");
    expect(sameAnnouncementConfig(initial, translated)).toBe(false);
    const textOnly = setAnnouncementText(initial, "sk", "greeting", expected.text);
    const withAudio = applyGeneratedAnnouncement(textOnly, "greeting", expected, generated)!;
    expect(sameAnnouncementConfig(textOnly, withAudio)).toBe(false);
  });

  it("finds incomplete drafts in inactive languages before saving the full line", () => {
    const config = setAnnouncementText(initial, "cs", "greeting", "  ");
    expect(config.language).toBe("sk");
    expect(emptyAnnouncementLanguages(config)).toEqual(["cs"]);
  });

  it("retains prepared drafts and generated audio when editing another category", () => {
    const prepared = setAnnouncementText(initial, "sk", "holdStart", expected.text);
    const withAudio = applyGeneratedAnnouncement(prepared, "holdStart", expected, generated)!;
    const editedGreeting = setAnnouncementText(withAudio, "cs", "greeting", "Dobrý den.");
    expect(resolveAnnouncement(editedGreeting, "holdStart")).toMatchObject({ text: expected.text, audioUrl: generated.audioUrl });
    expect(sameAnnouncementConfig(initial, withAudio)).toBe(false);
    expect(sameAnnouncementConfig(initial, resetAnnouncementPrompt(withAudio, "sk", "holdStart"))).toBe(true);
    expect(emptyAnnouncementLanguages(setAnnouncementText(editedGreeting, "de", "recordingPaused", " "))).toEqual(["de"]);
  });
});
