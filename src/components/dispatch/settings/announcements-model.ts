import {
  ANNOUNCEMENT_DEFINITIONS,
  ANNOUNCEMENT_LANGUAGES,
  resolveAnnouncement,
  type AnnouncementConfig,
  type AnnouncementKey,
  type AnnouncementLanguage,
} from "@/lib/telephony/announcements";

import type { GeneratedAnnouncement } from "./announcements-client";

/** Compare what the caller would hear, including all retained translations. */
export function sameAnnouncementConfig(left: AnnouncementConfig, right: AnnouncementConfig): boolean {
  if (left.language !== right.language || left.voiceId !== right.voiceId) return false;
  if ((left.recordingStatusAnnouncements === true) !== (right.recordingStatusAnnouncements === true)) return false;
  return ANNOUNCEMENT_LANGUAGES.every(({ code }) => ANNOUNCEMENT_DEFINITIONS.every(({ key }) => {
    const a = resolveAnnouncement(left, key, code);
    const b = resolveAnnouncement(right, key, code);
    return a.text === b.text && a.audioUrl === b.audioUrl;
  }));
}

/** Text and its generated audio are one pair: every edit drops that audio. */
export function setAnnouncementText(config: AnnouncementConfig, language: AnnouncementLanguage, key: AnnouncementKey, text: string): AnnouncementConfig {
  return { ...config, prompts: { ...config.prompts, [language]: { ...config.prompts[language], [key]: { text } } } };
}

export function resetAnnouncementPrompt(config: AnnouncementConfig, language: AnnouncementLanguage, key: AnnouncementKey): AnnouncementConfig {
  const prompts = { ...config.prompts[language] };
  delete prompts[key];
  return { ...config, prompts: { ...config.prompts, [language]: prompts } };
}

/** Generation can finish after a text/voice/language edit; never replace a newer draft. */
export function applyGeneratedAnnouncement(
  config: AnnouncementConfig,
  key: AnnouncementKey,
  expected: { language: AnnouncementLanguage; text: string; voiceId: string },
  generated: GeneratedAnnouncement,
): AnnouncementConfig | null {
  const { language, text, voiceId } = expected;
  if (config.voiceId !== voiceId || resolveAnnouncement(config, key, language).text.trim() !== text) return null;
  if (generated.text !== text || generated.language !== language || generated.voiceId !== voiceId) return null;
  return {
    ...config,
    prompts: { ...config.prompts, [language]: { ...config.prompts[language], [key]: { text, audioUrl: generated.audioUrl, voiceId } } },
  };
}

export function emptyAnnouncementLanguages(config: AnnouncementConfig): AnnouncementLanguage[] {
  return ANNOUNCEMENT_LANGUAGES.filter(({ code }) => ANNOUNCEMENT_DEFINITIONS.some(({ key }) => !resolveAnnouncement(config, key, code).text.trim())).map(({ code }) => code);
}
