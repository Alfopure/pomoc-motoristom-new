/** Caller-facing copy shared by the editor, generation API and call runtime. */
export const ANNOUNCEMENT_LANGUAGES = [
  { code: "sk", label: "Slovenčina", ttsVoice: "Azure.sk-SK-ViktoriaNeural", maleTtsVoice: "Azure.sk-SK-LukasNeural" },
  { code: "cs", label: "Čeština", ttsVoice: "Azure.cs-CZ-VlastaNeural", maleTtsVoice: "Azure.cs-CZ-AntoninNeural" },
  { code: "en", label: "English", ttsVoice: "Azure.en-GB-SoniaNeural", maleTtsVoice: "Azure.en-GB-RyanNeural" },
  { code: "de", label: "Deutsch", ttsVoice: "Azure.de-DE-KatjaNeural", maleTtsVoice: "Azure.de-DE-ConradNeural" },
] as const;
export type AnnouncementLanguage = (typeof ANNOUNCEMENT_LANGUAGES)[number]["code"];
export const ANNOUNCEMENT_VOICES = [
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah · pokojný ženský hlas" },
  { id: "onwK4e9ZLuTAKqWW03F9", label: "Daniel · pokojný mužský hlas" },
] as const;
export const DEFAULT_ANNOUNCEMENT_VOICE = ANNOUNCEMENT_VOICES[0].id;
export const MAX_ANNOUNCEMENT_TEXT = 600;
export const ANNOUNCEMENT_DEFINITIONS = [
  { key: "greeting", label: "Privítanie", description: "Krátky úvod pred spojením alebo hlasovým menu.", file: "greeting.mp3" },
  { key: "afterHours", label: "Mimo otváracích hodín", description: "Ponuka spätného volania stlačením jednotky.", file: "after-hours.mp3" },
  { key: "ivrMain", label: "Hlavné hlasové menu", description: "Jednotka spojí dispečing, dvojka požiada o spätné volanie. Text musí zodpovedať nastaveniu IVR menu.", file: "ivr-main.mp3" },
  { key: "callbackOffer", label: "Ponuka spätného volania", description: "Keď dispečeri nemôžu prijať hovor. Jednotka potvrdí spätné volanie.", file: "callback-offer.mp3" },
  { key: "callbackConfirmed", label: "Potvrdenie spätného volania", description: "Potvrdenie uloženej požiadavky pred ukončením hovoru.", file: "callback-confirmed.mp3" },
  { key: "allBusy", label: "Nikto nie je dostupný", description: "Záverečný odkaz pred ukončením hovoru.", file: "all-busy.mp3" },
  { key: "invalidInput", label: "Nesprávna voľba", description: "Výzva na zopakovanie voľby v hlasovom menu.", file: "invalid-input.mp3" },
  { key: "recordingNotice", label: "Upozornenie na nahrávanie", description: "Pripravený text pre budúce nahrávanie. Aktuálne sa volajúcim neprehráva.", file: "recording-notice.mp3" },
] as const;
export type AnnouncementKey = (typeof ANNOUNCEMENT_DEFINITIONS)[number]["key"];
export type AnnouncementPrompt = { text: string; audioUrl?: string; voiceId?: string };
export type AnnouncementConfig = {
  version: 1;
  language: AnnouncementLanguage;
  voiceId: string;
  prompts: Partial<Record<AnnouncementLanguage, Partial<Record<AnnouncementKey, AnnouncementPrompt>>>>;
};
export const DEFAULT_ANNOUNCEMENT_TEXTS: Record<AnnouncementLanguage, Record<AnnouncementKey, string>> = {
  sk: {
    greeting: "Pomoc motoristom. Prosím, zostaňte na linke.",
    afterHours: "Voláte mimo otváracích hodín. Pre spätné volanie stlačte jednotku.",
    ivrMain: "Pre dispečing stlačte jednotku. Pre spätné volanie dvojku.",
    callbackOffer: "Dispečeri práve telefonujú. Pre spätné volanie stlačte jednotku.",
    callbackConfirmed: "Ďakujeme. Vašu požiadavku máme. Ozveme sa vám čo najskôr.",
    allBusy: "Momentálne sa nedá spojiť s dispečerom. Prosím, zavolajte neskôr.",
    invalidInput: "Neplatná voľba. Prosím, vyberte znova.",
    recordingNotice: "Hovor nahrávame na vybavenie pomoci. Záznam sprístupňujeme poskytovateľom našich služieb. Prístup k záznamu alebo námietku riešte s dispečerom.",
  },
  cs: {
    greeting: "Vítejte na lince Pomoc motoristom. Vyčkejte prosím na spojení.",
    afterHours: "Voláte mimo otevírací dobu. Pro zpětné volání stiskněte jedničku.",
    ivrMain: "Pro dispečink stiskněte jedničku. Pro zpětné volání dvojku.",
    callbackOffer: "Dispečeři právě telefonují. Pro zpětné volání stiskněte jedničku.",
    callbackConfirmed: "Děkujeme. Váš požadavek máme. Ozveme se vám co nejdříve.",
    allBusy: "Momentálně vás nemůžeme spojit s dispečerem. Prosím, zavolejte později.",
    invalidInput: "Tuto možnost neznáme. Zkuste to prosím znovu.",
    recordingNotice: "Hovor nahráváme pro zajištění pomoci. Záznam zpřístupňujeme poskytovatelům našich služeb. Přístup k záznamu nebo námitku řešte s dispečerem.",
  },
  en: {
    greeting: "Pomoc motoristom, roadside assistance. Please stay on the line.",
    afterHours: "You are calling outside our opening hours. For a callback, press one.",
    ivrMain: "For dispatch, press one. For a callback, press two.",
    callbackOffer: "Our dispatchers are on other calls. For a callback, press one.",
    callbackConfirmed: "Thank you. We have your request and will call you back as soon as possible.",
    allBusy: "We cannot connect you to a dispatcher right now. Please call again later.",
    invalidInput: "Invalid choice. Please try again.",
    recordingNotice: "We record this call to arrange assistance. Recordings are shared with our service providers. Ask the dispatcher to access your recording or raise an objection.",
  },
  de: {
    greeting: "Pomoc motoristom, Pannenhilfe. Bitte bleiben Sie in der Leitung.",
    afterHours: "Sie rufen außerhalb unserer Öffnungszeiten an. Für einen Rückruf drücken Sie die Eins.",
    ivrMain: "Für die Leitstelle drücken Sie die Eins. Für einen Rückruf die Zwei.",
    callbackOffer: "Unsere Mitarbeiter sind im Gespräch. Für einen Rückruf drücken Sie die Eins.",
    callbackConfirmed: "Vielen Dank. Ihre Anfrage ist eingegangen. Wir rufen Sie so bald wie möglich zurück.",
    allBusy: "Wir können Sie gerade nicht mit der Leitstelle verbinden. Bitte rufen Sie später erneut an.",
    invalidInput: "Ungültige Auswahl. Bitte wählen Sie erneut.",
    recordingNotice: "Wir zeichnen diesen Anruf zur Organisation der Hilfe auf. Aufnahmen werden unseren Dienstleistern zugänglich gemacht. Für Zugang zur Aufnahme oder einen Widerspruch wenden Sie sich an die Leitstelle.",
  },
};
export function defaultAnnouncementConfig(): AnnouncementConfig {
  return { version: 1, language: "sk", voiceId: DEFAULT_ANNOUNCEMENT_VOICE, prompts: {} };
}
export function isAnnouncementLanguage(value: unknown): value is AnnouncementLanguage {
  return ANNOUNCEMENT_LANGUAGES.some((item) => item.code === value);
}
export function isAnnouncementKey(value: unknown): value is AnnouncementKey {
  return ANNOUNCEMENT_DEFINITIONS.some((item) => item.key === value);
}
export function isAnnouncementVoice(value: unknown): value is string {
  return ANNOUNCEMENT_VOICES.some((item) => item.id === value);
}
/** Stored unrecognised config falls back safely; strict input validation belongs to the write API. */
export function readAnnouncementConfig(value: unknown): AnnouncementConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultAnnouncementConfig();
  const raw = value as Partial<AnnouncementConfig>;
  if (raw.version !== 1 || !isAnnouncementLanguage(raw.language) || !isAnnouncementVoice(raw.voiceId)) return defaultAnnouncementConfig();
  const prompts: AnnouncementConfig["prompts"] = {};
  for (const { code } of ANNOUNCEMENT_LANGUAGES) {
    for (const { key } of ANNOUNCEMENT_DEFINITIONS) {
      const prompt = raw.prompts?.[code]?.[key];
      if (!prompt || typeof prompt.text !== "string" || !prompt.text.trim() || prompt.text.length > MAX_ANNOUNCEMENT_TEXT) continue;
      (prompts[code] ??= {})[key] = {
        text: prompt.text.trim(),
        ...(typeof prompt.audioUrl === "string" && /^https:\/\//.test(prompt.audioUrl) ? { audioUrl: prompt.audioUrl } : {}),
        ...(isAnnouncementVoice(prompt.voiceId) ? { voiceId: prompt.voiceId } : {}),
      };
    }
  }
  return { version: 1, language: raw.language, voiceId: raw.voiceId!, prompts };
}
export function announcementConfigFromMetadata(metadata: unknown): AnnouncementConfig {
  return readAnnouncementConfig(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>).announcements : null);
}
export function resolveAnnouncement(config: AnnouncementConfig, key: AnnouncementKey, language: AnnouncementLanguage = config.language) {
  const prompt = config.prompts[language]?.[key];
  const text = prompt?.text ?? DEFAULT_ANNOUNCEMENT_TEXTS[language][key];
  const isDefault = text === DEFAULT_ANNOUNCEMENT_TEXTS[language][key] && config.voiceId === DEFAULT_ANNOUNCEMENT_VOICE;
  const definition = ANNOUNCEMENT_DEFINITIONS.find((item) => item.key === key)!;
  // New paths bust Telnyx's media cache without changing custom IVR asset names.
  const file = `announcements-v1/${language}/${definition.file}`;
  const generated = prompt?.audioUrl && prompt.voiceId === config.voiceId;
  return {
    text,
    voice: config.voiceId === DEFAULT_ANNOUNCEMENT_VOICE
      ? ANNOUNCEMENT_LANGUAGES.find((item) => item.code === language)!.ttsVoice
      : ANNOUNCEMENT_LANGUAGES.find((item) => item.code === language)!.maleTtsVoice,
    voiceId: config.voiceId,
    audioUrl: generated ? prompt.audioUrl! : isDefault ? `/telephony/${file}` : null,
    file: generated ? prompt.audioUrl! : isDefault ? file : null,
    isDefault,
  };
}
export function estimatedAnnouncementSeconds(text: string): number {
  return Math.max(1, Math.ceil(text.trim().split(/\s+/).filter(Boolean).length / 2.2));
}
