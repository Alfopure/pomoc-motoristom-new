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
  sk: "Naša spoločnosť hovor nahráva na vybavenie pomoci. Informácie a námietky vybaví dispečer.",
  cs: "Naše společnost hovor nahrává pro zajištění pomoci. Informace a námitky vyřídí dispečer.",
  en: "Our company records this call to arrange assistance. Ask the dispatcher for details or to object.",
  de: "Wir zeichnen dieses Gespräch auf, um Ihnen zu helfen. Auskunft und Widerspruch sind bei der Leitstelle möglich.",
};
export const ANNOUNCEMENT_VOICES = [
  { id: "T4CPtAHlrClEH8iCFo2h", label: "Richard · prirodzený slovenský hlas", gender: "male" },
  { id: "GsFe19Xn8iGqNR2RxINi", label: "Jolana · jemný slovenský hlas", gender: "female" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah · pôvodný ženský hlas", gender: "female" },
  { id: "onwK4e9ZLuTAKqWW03F9", label: "Daniel · pôvodný mužský hlas", gender: "male" },
] as const;
export const DEFAULT_ANNOUNCEMENT_VOICE = ANNOUNCEMENT_VOICES[0].id;
/** Keep legacy presets byte-for-byte stable: saved audio URLs include their hash. */
export function announcementVoiceSettings(voiceId: string) {
  if (voiceId === "EXAVITQu4vr4xnSDxMaL" || voiceId === "onwK4e9ZLuTAKqWW03F9") {
    return { stability: 0.65, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1.05 };
  }
  return { stability: 0.4, similarity_boost: 0.75, style: 0, use_speaker_boost: false, speed: 1.1 };
}
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
  { key: "greeting", label: "Privítanie", description: "Krátky úvod pred spojením alebo hlasovým menu.", file: "greeting.mp3", assetVersion: "v4", category: "active", runtimeStatus: "active" },
  { key: "afterHours", label: "Mimo otváracích hodín", description: "Ponuka spätného volania stlačením jednotky.", file: "after-hours.mp3", assetVersion: "v4", category: "active", runtimeStatus: "active" },
  { key: "ivrMain", label: "Hlavné hlasové menu", description: "Jednotka spojí dispečing, dvojka požiada o spätné volanie. Text musí zodpovedať nastaveniu IVR menu.", file: "ivr-main.mp3", assetVersion: "v4", category: "active", runtimeStatus: "active" },
  { key: "callbackOffer", label: "Ponuka spätného volania", description: "Keď dispečeri nemôžu prijať hovor. Jednotka potvrdí spätné volanie.", file: "callback-offer.mp3", assetVersion: "v4", category: "active", runtimeStatus: "active" },
  { key: "callbackConfirmed", label: "Potvrdenie spätného volania", description: "Potvrdenie uloženej požiadavky pred ukončením hovoru.", file: "callback-confirmed.mp3", assetVersion: "v4", category: "active", runtimeStatus: "active" },
  { key: "allBusy", label: "Nikto nie je dostupný", description: "Záverečný odkaz pred ukončením hovoru.", file: "all-busy.mp3", assetVersion: "v4", category: "active", runtimeStatus: "active" },
  { key: "invalidInput", label: "Nesprávna voľba", description: "Výzva na zopakovanie voľby v hlasovom menu.", file: "invalid-input.mp3", assetVersion: "v4", category: "active", runtimeStatus: "active" },
  { key: "holdStart", label: "Podržanie hovoru", description: "Krátke oznámenie pri podržaní zákazníka pred hudbou.", file: "holdStart.mp3", assetVersion: "v4", category: "waiting", runtimeStatus: "active" },
  { key: "holdReminder", label: "Pripomenutie pri čakaní", description: "Poďakovanie pri čakaní bez dostupného čísla na spätné volanie.", file: "holdReminder.mp3", assetVersion: "v4", category: "waiting", runtimeStatus: "active" },
  { key: "queueWaiting", label: "Čakáreň a spätné volanie", description: "Výzva zostať na linke alebo stlačiť 1 pre spätné volanie. Minútu hudby pridá systém aj k vlastnému textu alebo hlasu; do nahrávky ju nevkladajte.", file: "queueWaiting.mp3", assetVersion: "v4", category: "waiting", runtimeStatus: "active" },
  { key: "resume", label: "Návrat k hovoru", description: "Voliteľné poďakovanie pred návratom operátora k hovoru.", file: "resume.mp3", assetVersion: "v4", category: "waiting", runtimeStatus: "active" },
  { key: "transferStart", label: "Začiatok prepájania", description: "Oznámenie pred prepájaním hovoru.", file: "transferStart.mp3", assetVersion: "v4", category: "handoff", runtimeStatus: "active" },
  { key: "transferFailed", label: "Neúspešné prepojenie", description: "Pre neúspešné prepojenie, ak zákazník zostáva na linke.", file: "transferFailed.mp3", assetVersion: "v4", category: "handoff", runtimeStatus: "prepared" },
  { key: "consultStart", label: "Overenie ďalšieho postupu", description: "Vysvetlenie čakania počas overovania ďalšieho postupu.", file: "consultStart.mp3", assetVersion: "v4", category: "handoff", runtimeStatus: "active" },
  { key: "parkStart", label: "Čakanie na prevzatie", description: "Oznámenie, že hovor čaká na prevzatie kolegom.", file: "parkStart.mp3", assetVersion: "v4", category: "handoff", runtimeStatus: "active" },
  { key: "conferenceJoin", label: "Pripojenie účastníka", description: "Upozornenie pred pripojením ďalšieho účastníka.", file: "conferenceJoin.mp3", assetVersion: "v4", category: "handoff", runtimeStatus: "active" },
  { key: "conferenceLeave", label: "Odchod účastníka", description: "Voliteľné potvrdenie odchodu účastníka.", file: "conferenceLeave.mp3", assetVersion: "v4", category: "handoff", runtimeStatus: "active" },
  { key: "outboundIntro", label: "Úvod odchádzajúceho hovoru", description: "Predstavenie služby po prijatí odchádzajúceho hovoru.", file: "outboundIntro.mp3", assetVersion: "v4", category: "other", runtimeStatus: "active" },
  { key: "noInput", label: "Voľba nezachytená", description: "Výzva pri nezachytenej voľbe v hlasovom menu.", file: "noInput.mp3", assetVersion: "v4", category: "other", runtimeStatus: "prepared" },
  { key: "afterHoursNoCallback", label: "Mimo hodín bez spätného volania", description: "Odkaz mimo otváracích hodín, ak chýba číslo volajúceho alebo zlyhá ponuka spätného volania.", file: "afterHoursNoCallback.mp3", assetVersion: "v4", category: "other", runtimeStatus: "active" },
  { key: "callbackFailed", label: "Neúspešné uloženie požiadavky", description: "Pravdivé oznámenie, ak požiadavku nemožno uložiť.", file: "callbackFailed.mp3", assetVersion: "v4", category: "other", runtimeStatus: "prepared" },
  { key: "recordingServiceNotice", label: "Nahrávanie na vybavenie pomoci", description: "Oznam pri nahrávaní na vybavenie pomoci bez kontroly kvality operátora.", file: "recordingServiceNotice.mp3", assetVersion: "v4", category: "recording", runtimeStatus: "active" },
  { key: "recordingNotice", label: "Nahrávanie a kontrola kvality", description: "Oznam pri zapnutom a schválenom vyhodnocovaní kvality operátora.", file: "recordingNotice.mp3", assetVersion: "v4", category: "recording", runtimeStatus: "active" },
  { key: "recordingPaused", label: "Potvrdenie vypnutia nahrávania", description: "Oznámenie určené až po skutočnom vypnutí nahrávania.", file: "recordingPaused.mp3", assetVersion: "v4", category: "recording", runtimeStatus: "active" },
  { key: "recordingResumed", label: "Obnovenie nahrávania", description: "Oznámenie pred povoleným obnovením nahrávania.", file: "recordingResumed.mp3", assetVersion: "v4", category: "recording", runtimeStatus: "active" },
  { key: "recordingUnavailable", label: "Pokračovanie bez nahrávania", description: "Oznámenie, keď pomoc pokračuje bez záznamu.", file: "recordingUnavailable.mp3", assetVersion: "v4", category: "recording", runtimeStatus: "prepared" },
] as const;
export type AnnouncementKey = (typeof ANNOUNCEMENT_DEFINITIONS)[number]["key"];
export type AnnouncementPrompt = { text: string; audioUrl?: string; voiceId?: string };
export type AnnouncementConfig = {
  version: 1;
  language: AnnouncementLanguage;
  voiceId: string;
  /** Legacy configurations omit this and keep mid-call recording status messages silent. */
  recordingStatusAnnouncements?: boolean;
  prompts: Partial<Record<AnnouncementLanguage, Partial<Record<AnnouncementKey, AnnouncementPrompt>>>>;
};
export const DEFAULT_ANNOUNCEMENT_TEXTS: Record<AnnouncementLanguage, Record<AnnouncementKey, string>> = {
  "sk": {
    "greeting": "Pomoc motoristom, dobrý deň.",
    "afterHours": "Teraz máme zatvorené. Pre spätné volanie stlačte jednotku.",
    "ivrMain": "Pre dispečing stlačte jednotku. Pre spätné volanie dvojku.",
    "callbackOffer": "Práve telefonujeme. Pre spätné volanie stlačte jednotku.",
    "callbackConfirmed": "Ďakujeme, zavoláme vám späť.",
    "allBusy": "Teraz vás nevieme spojiť. Prosím, zavolajte neskôr.",
    "invalidInput": "Neplatná voľba. Skúste znova, prosím.",
    "holdStart": "Chvíľku, prosím. Zostaňte na linke.",
    "holdReminder": "Ďakujeme, že čakáte.",
    "queueWaiting": "Ďakujeme, že čakáte. Práve telefonujeme. Pre spätné volanie stlačte jednotku.",
    "resume": "Ďakujeme za počkanie.",
    "transferStart": "Prepojíme vás, chvíľku prosím.",
    "transferFailed": "Prepojenie sa nepodarilo. Zostaňte, prosím, na linke.",
    "consultStart": "Overíme ďalší postup. Chvíľku, prosím.",
    "parkStart": "Čakáme na kolegu. Zostaňte, prosím, na linke.",
    "conferenceJoin": "Pripájame ďalšieho účastníka.",
    "conferenceLeave": "Účastník sa odpojil.",
    "outboundIntro": "Dobrý deň, voláme z Pomoci motoristom.",
    "noInput": "Voľbu sme nezachytili. Skúste znova, prosím.",
    "afterHoursNoCallback": "Teraz máme zatvorené. Zavolajte neskôr, prosím.",
    "callbackFailed": "Požiadavku sa nepodarilo uložiť. Zavolajte neskôr, prosím.",
    "recordingServiceNotice": SERVICE_RECORDING_NOTICE_TEXTS.sk,
    "recordingNotice": "Naša spoločnosť hovor nahráva na vybavenie pomoci a kontrolu kvality. Informácie a námietky vybaví dispečer.",
    "recordingPaused": "Nahrávanie je vypnuté.",
    "recordingResumed": "Pokračujeme v nahrávaní.",
    "recordingUnavailable": "Pokračujeme bez nahrávania."
  },
  "cs": {
    "greeting": "Pomoc motoristům, dobrý den.",
    "afterHours": "Teď máme zavřeno. Pro zpětné volání stiskněte jedničku.",
    "ivrMain": "Pro dispečink stiskněte jedničku. Pro zpětné volání dvojku.",
    "callbackOffer": "Právě telefonujeme. Pro zpětné volání stiskněte jedničku.",
    "callbackConfirmed": "Děkujeme, zavoláme vám zpět.",
    "allBusy": "Teď vás nemůžeme spojit. Zavolejte později, prosím.",
    "invalidInput": "Neplatná volba. Zkuste to znovu, prosím.",
    "holdStart": "Chvilku, prosím. Zůstaňte na lince.",
    "holdReminder": "Děkujeme, že čekáte.",
    "queueWaiting": "Děkujeme, že čekáte. Právě telefonujeme. Pro zpětné volání stiskněte jedničku.",
    "resume": "Děkujeme za počkání.",
    "transferStart": "Přepojíme vás, chvilku prosím.",
    "transferFailed": "Přepojení se nepodařilo. Zůstaňte, prosím, na lince.",
    "consultStart": "Ověříme další postup. Chvilku, prosím.",
    "parkStart": "Čekáme na kolegu. Zůstaňte, prosím, na lince.",
    "conferenceJoin": "Připojujeme dalšího účastníka.",
    "conferenceLeave": "Účastník se odpojil.",
    "outboundIntro": "Dobrý den, voláme z Pomoci motoristům.",
    "noInput": "Volbu jsme nezachytili. Zkuste to znovu, prosím.",
    "afterHoursNoCallback": "Teď máme zavřeno. Zavolejte později, prosím.",
    "callbackFailed": "Požadavek se nepodařilo uložit. Zavolejte později, prosím.",
    "recordingServiceNotice": SERVICE_RECORDING_NOTICE_TEXTS.cs,
    "recordingNotice": "Naše společnost hovor nahrává pro zajištění pomoci a kontrolu kvality. Informace a námitky vyřídí dispečer.",
    "recordingPaused": "Nahrávání je vypnuto.",
    "recordingResumed": "Pokračujeme v nahrávání.",
    "recordingUnavailable": "Pokračujeme bez nahrávání."
  },
  "en": {
    "greeting": "Hello, Pomoc motoristom roadside assistance.",
    "afterHours": "We're closed at the moment. For a callback, press one.",
    "ivrMain": "For the dispatcher, press one. For a callback, press two.",
    "callbackOffer": "We're on other calls. For a callback, press one.",
    "callbackConfirmed": "Thank you. We'll call you back.",
    "allBusy": "We can't connect you right now. Please call again later.",
    "invalidInput": "That option isn't available. Please try again.",
    "holdStart": "One moment, please. Stay on the line.",
    "holdReminder": "Thank you for waiting.",
    "queueWaiting": "Thank you for waiting. We're on other calls. For a callback, press one.",
    "resume": "Thanks for holding.",
    "transferStart": "Please hold while we transfer your call.",
    "transferFailed": "We couldn't transfer you. Please stay on the line.",
    "consultStart": "We'll check the next steps. One moment, please.",
    "parkStart": "We're waiting for a colleague. Please stay on the line.",
    "conferenceJoin": "We're adding another person to the call.",
    "conferenceLeave": "A participant has left the call.",
    "outboundIntro": "Hello, we're calling from Pomoc motoristom roadside assistance.",
    "noInput": "We didn't get your selection. Please try again.",
    "afterHoursNoCallback": "We're closed at the moment. Please call again later.",
    "callbackFailed": "We couldn't save your request. Please call again later.",
    "recordingServiceNotice": SERVICE_RECORDING_NOTICE_TEXTS.en,
    "recordingNotice": "Our company records this call to arrange assistance and check service quality. Ask the dispatcher for details or to object.",
    "recordingPaused": "Recording is off.",
    "recordingResumed": "We're resuming the recording.",
    "recordingUnavailable": "We'll continue without recording."
  },
  "de": {
    "greeting": "Guten Tag, hier ist Pomoc motoristom, Ihre Pannenhilfe.",
    "afterHours": "Wir sind gerade geschlossen. Für einen Rückruf bitte die Eins drücken.",
    "ivrMain": "Für die Leitstelle drücken Sie die Eins. Für einen Rückruf die Zwei.",
    "callbackOffer": "Wir sind gerade im Gespräch. Für einen Rückruf bitte die Eins drücken.",
    "callbackConfirmed": "Vielen Dank. Wir rufen Sie zurück.",
    "allBusy": "Wir können Sie gerade nicht verbinden. Bitte rufen Sie später erneut an.",
    "invalidInput": "Diese Auswahl ist ungültig. Bitte versuchen Sie es erneut.",
    "holdStart": "Einen Moment bitte. Bleiben Sie in der Leitung.",
    "holdReminder": "Danke, dass Sie warten.",
    "queueWaiting": "Danke, dass Sie warten. Wir sind gerade im Gespräch. Für einen Rückruf bitte die Eins drücken.",
    "resume": "Danke fürs Warten.",
    "transferStart": "Wir verbinden Sie weiter. Einen Moment bitte.",
    "transferFailed": "Die Verbindung hat nicht geklappt. Bitte bleiben Sie in der Leitung.",
    "consultStart": "Wir klären das weitere Vorgehen. Einen Moment bitte.",
    "parkStart": "Wir warten auf einen Kollegen. Bitte bleiben Sie in der Leitung.",
    "conferenceJoin": "Wir nehmen eine weitere Person ins Gespräch auf.",
    "conferenceLeave": "Ein Teilnehmer hat das Gespräch verlassen.",
    "outboundIntro": "Guten Tag, wir rufen von Pomoc motoristom an.",
    "noInput": "Wir haben keine Auswahl erkannt. Bitte versuchen Sie es erneut.",
    "afterHoursNoCallback": "Wir sind gerade geschlossen. Bitte rufen Sie später erneut an.",
    "callbackFailed": "Ihre Anfrage konnte nicht gespeichert werden. Bitte rufen Sie später erneut an.",
    "recordingServiceNotice": SERVICE_RECORDING_NOTICE_TEXTS.de,
    "recordingNotice": "Wir zeichnen dieses Gespräch auf, um Ihnen zu helfen und unsere Servicequalität zu prüfen. Auskunft und Widerspruch sind bei der Leitstelle möglich.",
    "recordingPaused": "Die Aufzeichnung ist ausgeschaltet.",
    "recordingResumed": "Wir setzen die Aufzeichnung fort.",
    "recordingUnavailable": "Wir sprechen ohne Aufzeichnung weiter."
  }
};
export function defaultAnnouncementConfig(): AnnouncementConfig {
  return { version: 1, language: "sk", voiceId: DEFAULT_ANNOUNCEMENT_VOICE, recordingStatusAnnouncements: false, prompts: {} };
}
/** Initial recording notices are always enabled; this controls only status updates. */
export function isAnnouncementEnabled(config: AnnouncementConfig, key: AnnouncementKey): boolean {
  return !["recordingPaused", "recordingResumed", "recordingUnavailable"].includes(key) || config.recordingStatusAnnouncements === true;
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
  return { version: 1, language: raw.language, voiceId: raw.voiceId!, recordingStatusAnnouncements: raw.recordingStatusAnnouncements === true, prompts };
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
    voice: ANNOUNCEMENT_VOICES.find((item) => item.id === config.voiceId)?.gender === "female"
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
