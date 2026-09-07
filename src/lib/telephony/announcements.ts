/** Caller-facing copy shared by the editor, generation API and call runtime. */
export const ANNOUNCEMENT_LANGUAGES = [
  { code: "sk", label: "Slovenčina", ttsVoice: "Azure.sk-SK-ViktoriaNeural", maleTtsVoice: "Azure.sk-SK-LukasNeural" },
  { code: "cs", label: "Čeština", ttsVoice: "Azure.cs-CZ-VlastaNeural", maleTtsVoice: "Azure.cs-CZ-AntoninNeural" },
  { code: "en", label: "English", ttsVoice: "Azure.en-GB-SoniaNeural", maleTtsVoice: "Azure.en-GB-RyanNeural" },
  { code: "de", label: "Deutsch", ttsVoice: "Azure.de-DE-KatjaNeural", maleTtsVoice: "Azure.de-DE-ConradNeural" },
] as const;
export type AnnouncementLanguage = (typeof ANNOUNCEMENT_LANGUAGES)[number]["code"];
/** Purpose-specific fallback when the approved policy does not permit quality evaluation. */
export const SERVICE_RECORDING_NOTICE_TEXTS: Record<AnnouncementLanguage, string> = {
  sk: "Alfopure hovor nahráva a automaticky spracúva na vybavenie pomoci. Informácie, prístup k záznamu alebo námietku riešte s dispečerom.",
  cs: "Alfopure hovor nahrává a automaticky zpracovává pro zajištění pomoci. Informace, přístup k záznamu nebo námitku řešte s dispečerem.",
  en: "Alfopure records and automatically processes this call to arrange assistance. Ask the dispatcher for information, access to the recording, or to object.",
  de: "Alfopure zeichnet diesen Anruf auf und verarbeitet ihn automatisch, um Hilfe zu organisieren. Für Informationen, Zugang zur Aufnahme oder Widerspruch fragen Sie die Leitstelle.",
};
export const ANNOUNCEMENT_VOICES = [
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah · pokojný ženský hlas" },
  { id: "onwK4e9ZLuTAKqWW03F9", label: "Daniel · pokojný mužský hlas" },
] as const;
export const DEFAULT_ANNOUNCEMENT_VOICE = ANNOUNCEMENT_VOICES[0].id;
export const MAX_ANNOUNCEMENT_TEXT = 600;
export const ANNOUNCEMENT_CATEGORIES = [
  { key: "active", label: "Používané v hovoroch" },
  { key: "waiting", label: "Čakanie a návrat" },
  { key: "handoff", label: "Prepájanie a účastníci" },
  { key: "other", label: "Ďalšie situácie" },
  { key: "recording", label: "Nahrávanie" },
] as const;
export type AnnouncementCategory = (typeof ANNOUNCEMENT_CATEGORIES)[number]["key"];
export const ANNOUNCEMENT_DEFINITIONS = [
  { key: "greeting", label: "Privítanie", description: "Krátky úvod pred spojením alebo hlasovým menu.", file: "greeting.mp3", assetVersion: "v1", category: "active", runtimeStatus: "active" },
  { key: "afterHours", label: "Mimo otváracích hodín", description: "Ponuka spätného volania stlačením jednotky.", file: "after-hours.mp3", assetVersion: "v1", category: "active", runtimeStatus: "active" },
  { key: "ivrMain", label: "Hlavné hlasové menu", description: "Jednotka spojí dispečing, dvojka požiada o spätné volanie. Text musí zodpovedať nastaveniu IVR menu.", file: "ivr-main.mp3", assetVersion: "v1", category: "active", runtimeStatus: "active" },
  { key: "callbackOffer", label: "Ponuka spätného volania", description: "Keď dispečeri nemôžu prijať hovor. Jednotka potvrdí spätné volanie.", file: "callback-offer.mp3", assetVersion: "v1", category: "active", runtimeStatus: "active" },
  { key: "callbackConfirmed", label: "Potvrdenie spätného volania", description: "Potvrdenie uloženej požiadavky pred ukončením hovoru.", file: "callback-confirmed.mp3", assetVersion: "v1", category: "active", runtimeStatus: "active" },
  { key: "allBusy", label: "Nikto nie je dostupný", description: "Záverečný odkaz pred ukončením hovoru.", file: "all-busy.mp3", assetVersion: "v1", category: "active", runtimeStatus: "active" },
  { key: "invalidInput", label: "Nesprávna voľba", description: "Výzva na zopakovanie voľby v hlasovom menu.", file: "invalid-input.mp3", assetVersion: "v1", category: "active", runtimeStatus: "active" },
  { key: "holdStart", label: "Podržanie hovoru", description: "Krátke oznámenie pri podržaní zákazníka pred hudbou.", file: "holdStart.mp3", assetVersion: "v2", category: "waiting", runtimeStatus: "active" },
  { key: "holdReminder", label: "Pripomenutie pri čakaní", description: "Poďakovanie počas dlhšieho čakania.", file: "holdReminder.mp3", assetVersion: "v2", category: "waiting", runtimeStatus: "prepared" },
  { key: "queueWaiting", label: "Čakáreň a spätné volanie", description: "Výzva zostať na linke alebo stlačiť 1 pre spätné volanie, potom minúta hudby. Opakuje sa počas čakania.", file: "queueWaiting.mp3", assetVersion: "v3", category: "waiting", runtimeStatus: "active" },
  { key: "resume", label: "Návrat k hovoru", description: "Voliteľné poďakovanie pred návratom operátora k hovoru.", file: "resume.mp3", assetVersion: "v2", category: "waiting", runtimeStatus: "active" },
  { key: "transferStart", label: "Začiatok prepájania", description: "Oznámenie pred prepájaním hovoru.", file: "transferStart.mp3", assetVersion: "v2", category: "handoff", runtimeStatus: "active" },
  { key: "transferFailed", label: "Neúspešné prepojenie", description: "Pre neúspešné prepojenie, ak zákazník zostáva na linke.", file: "transferFailed.mp3", assetVersion: "v2", category: "handoff", runtimeStatus: "prepared" },
  { key: "consultStart", label: "Overenie ďalšieho postupu", description: "Vysvetlenie čakania počas overovania ďalšieho postupu.", file: "consultStart.mp3", assetVersion: "v2", category: "handoff", runtimeStatus: "active" },
  { key: "parkStart", label: "Čakanie na prevzatie", description: "Oznámenie, že hovor čaká na prevzatie kolegom.", file: "parkStart.mp3", assetVersion: "v2", category: "handoff", runtimeStatus: "active" },
  { key: "conferenceJoin", label: "Pripojenie účastníka", description: "Upozornenie pred pripojením ďalšieho účastníka.", file: "conferenceJoin.mp3", assetVersion: "v2", category: "handoff", runtimeStatus: "active" },
  { key: "conferenceLeave", label: "Odchod účastníka", description: "Voliteľné potvrdenie odchodu účastníka.", file: "conferenceLeave.mp3", assetVersion: "v2", category: "handoff", runtimeStatus: "active" },
  { key: "outboundIntro", label: "Úvod odchádzajúceho hovoru", description: "Predstavenie služby po prijatí odchádzajúceho hovoru.", file: "outboundIntro.mp3", assetVersion: "v2", category: "other", runtimeStatus: "active" },
  { key: "noInput", label: "Voľba nezachytená", description: "Výzva pri nezachytenej voľbe v hlasovom menu.", file: "noInput.mp3", assetVersion: "v2", category: "other", runtimeStatus: "prepared" },
  { key: "afterHoursNoCallback", label: "Mimo hodín bez spätného volania", description: "Odkaz mimo otváracích hodín, ak spätné volanie nie je dostupné.", file: "afterHoursNoCallback.mp3", assetVersion: "v2", category: "other", runtimeStatus: "prepared" },
  { key: "callbackFailed", label: "Neúspešné uloženie požiadavky", description: "Pravdivé oznámenie, ak požiadavku nemožno uložiť.", file: "callbackFailed.mp3", assetVersion: "v2", category: "other", runtimeStatus: "prepared" },
  { key: "recordingServiceNotice", label: "Nahrávanie na vybavenie pomoci", description: "Oznam pri nahrávaní na vybavenie pomoci bez kontroly kvality operátora.", file: "recordingServiceNotice.mp3", assetVersion: "v2", category: "recording", runtimeStatus: "active" },
  { key: "recordingNotice", label: "Nahrávanie a kontrola kvality", description: "Oznam pri zapnutom a schválenom vyhodnocovaní kvality operátora.", file: "recordingNotice.mp3", assetVersion: "v2", category: "recording", runtimeStatus: "active" },
  { key: "recordingPaused", label: "Potvrdenie vypnutia nahrávania", description: "Oznámenie určené až po skutočnom vypnutí nahrávania.", file: "recordingPaused.mp3", assetVersion: "v2", category: "recording", runtimeStatus: "active" },
  { key: "recordingResumed", label: "Obnovenie nahrávania", description: "Oznámenie pred povoleným obnovením nahrávania.", file: "recordingResumed.mp3", assetVersion: "v2", category: "recording", runtimeStatus: "active" },
  { key: "recordingUnavailable", label: "Pokračovanie bez nahrávania", description: "Oznámenie, keď pomoc pokračuje bez záznamu.", file: "recordingUnavailable.mp3", assetVersion: "v2", category: "recording", runtimeStatus: "prepared" },
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
  "sk": {
    "greeting": "Pomoc motoristom. Prosím, zostaňte na linke.",
    "afterHours": "Voláte mimo otváracích hodín. Pre spätné volanie stlačte jednotku.",
    "ivrMain": "Pre dispečing stlačte jednotku. Pre spätné volanie dvojku.",
    "callbackOffer": "Dispečeri práve telefonujú. Pre spätné volanie stlačte jednotku.",
    "callbackConfirmed": "Ďakujeme. Vašu požiadavku máme. Ozveme sa vám čo najskôr.",
    "allBusy": "Momentálne sa nedá spojiť s dispečerom. Prosím, zavolajte neskôr.",
    "invalidInput": "Neplatná voľba. Prosím, vyberte znova.",
    "holdStart": "Prosím, chvíľu počkajte na linke.",
    "holdReminder": "Ďakujeme, že čakáte. Prosím, zostaňte na linke.",
    "queueWaiting": "Ďakujeme, že čakáte. Prosím, zostaňte na linke. Dispečeri práve telefonujú. Pre spätné volanie stlačte jednotku.",
    "resume": "Ďakujeme, že ste počkali.",
    "transferStart": "Prepájame vás. Prosím, zostaňte na linke.",
    "transferFailed": "Spojenie sa nepodarilo. Prosím, zostaňte na linke.",
    "consultStart": "Dispečer overuje ďalší postup. Prosím, počkajte na linke.",
    "parkStart": "Váš hovor čaká na prevzatie. Prosím, zostaňte na linke.",
    "conferenceJoin": "Do hovoru sa pripája ďalší účastník.",
    "conferenceLeave": "Účastník opustil hovor.",
    "outboundIntro": "Dobrý deň, voláme z Pomoci motoristom.",
    "noInput": "Voľbu sme nezachytili. Prosím, skúste znova.",
    "afterHoursNoCallback": "Voláte mimo otváracích hodín. Prosím, zavolajte neskôr.",
    "callbackFailed": "Požiadavku sa nepodarilo uložiť. Prosím, zavolajte neskôr.",
    "recordingServiceNotice": SERVICE_RECORDING_NOTICE_TEXTS.sk,
    "recordingNotice": "Alfopure hovor nahráva a automaticky vyhodnocuje na vybavenie pomoci a kontrolu kvality. Informácie, prístup k záznamu alebo námietku riešte s dispečerom.",
    "recordingPaused": "Nahrávanie je vypnuté.",
    "recordingResumed": "Nahrávanie sa opäť zapína.",
    "recordingUnavailable": "Hovor bude pokračovať bez nahrávania."
  },
  "cs": {
    "greeting": "Vítejte na lince Pomoc motoristom. Vyčkejte prosím na spojení.",
    "afterHours": "Voláte mimo otevírací dobu. Pro zpětné volání stiskněte jedničku.",
    "ivrMain": "Pro dispečink stiskněte jedničku. Pro zpětné volání dvojku.",
    "callbackOffer": "Dispečeři právě telefonují. Pro zpětné volání stiskněte jedničku.",
    "callbackConfirmed": "Děkujeme. Váš požadavek máme. Ozveme se vám co nejdříve.",
    "allBusy": "Momentálně vás nemůžeme spojit s dispečerem. Prosím, zavolejte později.",
    "invalidInput": "Tuto možnost neznáme. Zkuste to prosím znovu.",
    "holdStart": "Prosím, chvíli vyčkejte na lince.",
    "holdReminder": "Děkujeme, že čekáte. Prosím, zůstaňte na lince.",
    "queueWaiting": "Děkujeme, že čekáte. Prosím, zůstaňte na lince. Dispečeři právě telefonují. Pro zpětné volání stiskněte jedničku.",
    "resume": "Děkujeme, že jste počkali.",
    "transferStart": "Přepojujeme vás. Prosím, zůstaňte na lince.",
    "transferFailed": "Spojení se nezdařilo. Prosím, zůstaňte na lince.",
    "consultStart": "Dispečer ověřuje další postup. Prosím, vyčkejte na lince.",
    "parkStart": "Váš hovor čeká na převzetí. Prosím, zůstaňte na lince.",
    "conferenceJoin": "K hovoru se připojuje další účastník.",
    "conferenceLeave": "Účastník opustil hovor.",
    "outboundIntro": "Dobrý den, voláme z linky Pomoc motoristom.",
    "noInput": "Volbu jsme nezachytili. Prosím, zkuste to znovu.",
    "afterHoursNoCallback": "Voláte mimo otevírací dobu. Prosím, zavolejte později.",
    "callbackFailed": "Požadavek se nepodařilo uložit. Prosím, zavolejte později.",
    "recordingServiceNotice": SERVICE_RECORDING_NOTICE_TEXTS.cs,
    "recordingNotice": "Alfopure hovor nahrává a automaticky vyhodnocuje pro zajištění pomoci a kontrolu kvality. Informace, přístup k záznamu nebo námitku řešte s dispečerem.",
    "recordingPaused": "Nahrávání je vypnuté.",
    "recordingResumed": "Nahrávání se znovu zapíná.",
    "recordingUnavailable": "Hovor bude pokračovat bez nahrávání."
  },
  "en": {
    "greeting": "Pomoc motoristom, roadside assistance. Please stay on the line.",
    "afterHours": "You are calling outside our opening hours. For a callback, press one.",
    "ivrMain": "For dispatch, press one. For a callback, press two.",
    "callbackOffer": "Our dispatchers are on other calls. For a callback, press one.",
    "callbackConfirmed": "Thank you. We have your request and will call you back as soon as possible.",
    "allBusy": "We cannot connect you to a dispatcher right now. Please call again later.",
    "invalidInput": "Invalid choice. Please try again.",
    "holdStart": "Please hold for a moment.",
    "holdReminder": "Thank you for waiting. Please stay on the line.",
    "queueWaiting": "Thank you for waiting. Please stay on the line. Our dispatchers are on other calls. For a callback, press one.",
    "resume": "Thank you for holding.",
    "transferStart": "We are transferring your call. Please stay on the line.",
    "transferFailed": "We could not connect your call. Please stay on the line.",
    "consultStart": "The dispatcher is checking the next steps. Please hold.",
    "parkStart": "Your call is waiting to be picked up. Please stay on the line.",
    "conferenceJoin": "Another participant is joining the call.",
    "conferenceLeave": "A participant has left the call.",
    "outboundIntro": "Hello, this is Pomoc motoristom roadside assistance.",
    "noInput": "We did not receive your selection. Please try again.",
    "afterHoursNoCallback": "You are calling outside our opening hours. Please call again later.",
    "callbackFailed": "We could not save your callback request. Please call again later.",
    "recordingServiceNotice": SERVICE_RECORDING_NOTICE_TEXTS.en,
    "recordingNotice": "Alfopure records and automatically reviews this call to arrange assistance and check service quality. Ask the dispatcher for information, access to the recording, or to object.",
    "recordingPaused": "Recording is off.",
    "recordingResumed": "Recording will now resume.",
    "recordingUnavailable": "The call will continue without recording."
  },
  "de": {
    "greeting": "Pomoc motoristom, Pannenhilfe. Bitte bleiben Sie in der Leitung.",
    "afterHours": "Sie rufen außerhalb unserer Öffnungszeiten an. Für einen Rückruf drücken Sie die Eins.",
    "ivrMain": "Für die Leitstelle drücken Sie die Eins. Für einen Rückruf die Zwei.",
    "callbackOffer": "Unsere Mitarbeiter sind im Gespräch. Für einen Rückruf drücken Sie die Eins.",
    "callbackConfirmed": "Vielen Dank. Ihre Anfrage ist eingegangen. Wir rufen Sie so bald wie möglich zurück.",
    "allBusy": "Wir können Sie gerade nicht mit der Leitstelle verbinden. Bitte rufen Sie später erneut an.",
    "invalidInput": "Ungültige Auswahl. Bitte wählen Sie erneut.",
    "holdStart": "Bitte bleiben Sie kurz in der Leitung.",
    "holdReminder": "Vielen Dank für Ihre Geduld. Bitte bleiben Sie in der Leitung.",
    "queueWaiting": "Vielen Dank für Ihre Geduld. Bitte bleiben Sie in der Leitung. Unsere Mitarbeiter sind im Gespräch. Für einen Rückruf drücken Sie die Eins.",
    "resume": "Vielen Dank für Ihre Geduld.",
    "transferStart": "Wir verbinden Sie weiter. Bitte bleiben Sie in der Leitung.",
    "transferFailed": "Die Verbindung ist nicht zustande gekommen. Bitte bleiben Sie in der Leitung.",
    "consultStart": "Die Leitstelle klärt die nächsten Schritte. Bitte bleiben Sie in der Leitung.",
    "parkStart": "Ihr Anruf wartet auf Übernahme. Bitte bleiben Sie in der Leitung.",
    "conferenceJoin": "Eine weitere Person nimmt am Gespräch teil.",
    "conferenceLeave": "Eine Person hat das Gespräch verlassen.",
    "outboundIntro": "Guten Tag, hier ist die Pannenhilfe Pomoc motoristom.",
    "noInput": "Wir haben keine Auswahl erhalten. Bitte versuchen Sie es erneut.",
    "afterHoursNoCallback": "Sie rufen außerhalb unserer Öffnungszeiten an. Bitte rufen Sie später erneut an.",
    "callbackFailed": "Wir konnten Ihren Rückrufwunsch nicht speichern. Bitte rufen Sie später erneut an.",
    "recordingServiceNotice": SERVICE_RECORDING_NOTICE_TEXTS.de,
    "recordingNotice": "Alfopure zeichnet diesen Anruf auf und wertet ihn automatisch aus, um Hilfe zu organisieren und die Qualität zu prüfen. Für Informationen, Zugang zur Aufnahme oder Widerspruch fragen Sie die Leitstelle.",
    "recordingPaused": "Die Aufzeichnung ist ausgeschaltet.",
    "recordingResumed": "Die Aufzeichnung wird jetzt fortgesetzt.",
    "recordingUnavailable": "Das Gespräch wird ohne Aufzeichnung fortgesetzt."
  }
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
  const file = `announcements-${definition.assetVersion}/${language}/${definition.file}`;
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
