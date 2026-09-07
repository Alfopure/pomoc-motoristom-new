"use client";

import { useEffect, useRef, useState } from "react";
import { AudioLines, Check, Clock3, Globe2, Headphones, Loader2, Mic2, RefreshCw, RotateCcw, Save, ShieldCheck, Sparkles } from "lucide-react";

import {
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_DEFINITIONS,
  ANNOUNCEMENT_LANGUAGES,
  ANNOUNCEMENT_VOICES,
  MAX_ANNOUNCEMENT_TEXT,
  isAnnouncementEnabled,
  resolveAnnouncement,
  estimatedAnnouncementSeconds,
  type AnnouncementConfig,
  type AnnouncementCategory,
  type AnnouncementKey,
  type AnnouncementLanguage,
} from "@/lib/telephony/announcements";

import { AnnouncementRequestError, generateAnnouncement, loadAnnouncements, saveAnnouncements, type AnnouncementLine, type AnnouncementsResponse } from "./announcements-client";
import { applyGeneratedAnnouncement, emptyAnnouncementLanguages, resetAnnouncementPrompt, sameAnnouncementConfig, setAnnouncementText } from "./announcements-model";
import { SettingsField, SettingsNotice, SettingsSectionHeader, settingsInputClass } from "./settings-ui";

const buttonClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 transition-colors hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 disabled:cursor-not-allowed disabled:opacity-50";

const LANGUAGE_LABELS: Record<AnnouncementLanguage, string> = { sk: "Slovenčina", cs: "Čeština", en: "English", de: "Deutsch" };

/** Kept mounted by the settings tabs so moving between editors retains drafts. */
export function AnnouncementsPanel({ active = true }: { active?: boolean }) {
  const [response, setResponse] = useState<AnnouncementsResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, AnnouncementConfig>>({});
  const [lineId, setLineId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: "success" | "warning" } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState<string | null>(null);
  const [audioErrors, setAudioErrors] = useState<Record<string, string>>({});
  const [category, setCategory] = useState<AnnouncementCategory>("active");
  const panelRef = useRef<HTMLElement>(null);
  const generationSequence = useRef(0);
  const promptVersions = useRef<Record<string, number>>({});
  const liveDrafts = useRef(drafts);

  useEffect(() => { liveDrafts.current = drafts; }, [drafts]);

  useEffect(() => {
    const controller = new AbortController();
    loadAnnouncements(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setResponse(result);
        setDrafts((previous) => Object.fromEntries(result.lines.map((line) => [line.id, previous[line.id] ?? line.config])));
        setLineId((previous) => result.lines.some((line) => line.id === previous) ? previous : result.lines[0]?.id ?? "");
        setError(null);
        setConflict(false);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Hlášky sa nepodarilo načítať.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reloadToken]);

  const hasUnsavedChanges = Boolean(response?.lines.some((line) => drafts[line.id] && !sameAnnouncementConfig(line.config, drafts[line.id])));
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const preventUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (!active) panelRef.current?.querySelectorAll("audio").forEach((audio) => audio.pause());
  }, [active]);

  const line = response?.lines.find((entry) => entry.id === lineId);
  const config = line ? drafts[line.id] ?? line.config : null;
  const canEdit = Boolean(response?.canEdit);
  const dirty = Boolean(line && config && !sameAnnouncementConfig(line.config, config));
  const emptyLanguages = config ? emptyAnnouncementLanguages(config) : [];

  function updateConfig(next: AnnouncementConfig) {
    if (!line || !canEdit || saving) return;
    setDrafts((previous) => ({ ...previous, [line.id]: next }));
    liveDrafts.current = { ...liveDrafts.current, [line.id]: next };
    setNotice(null);
    setError(null);
  }

  function updateText(key: AnnouncementKey, text: string) {
    if (!config) return;
    const id = `${lineId}:${config.language}:${key}`;
    promptVersions.current[id] = (promptVersions.current[id] ?? 0) + 1;
    updateConfig(setAnnouncementText(config, config.language, key, text));
  }

  function resetPrompt(key: AnnouncementKey) {
    if (!config) return;
    const id = `${lineId}:${config.language}:${key}`;
    promptVersions.current[id] = (promptVersions.current[id] ?? 0) + 1;
    updateConfig(resetAnnouncementPrompt(config, config.language, key));
  }

  async function generate(key: AnnouncementKey) {
    if (!line || !config || !canEdit || !response?.generationAvailable || saving || generating) return;
    const selectedLineId = line.id;
    const language = config.language;
    const text = resolveAnnouncement(config, key, language).text.trim();
    const selectedVoiceId = config.voiceId;
    const token = ++generationSequence.current;
    const requestId = `${selectedLineId}:${language}:${key}`;
    const promptVersion = promptVersions.current[requestId] ?? 0;
    setGenerating(requestId);
    setError(null);
    setNotice(null);
    try {
      const generated = await generateAnnouncement({ lineId: selectedLineId, language, key, text, voiceId: selectedVoiceId });
      if (token !== generationSequence.current) return;
      const latest = liveDrafts.current[selectedLineId];
      const next = latest ? applyGeneratedAnnouncement(latest, key, { language, text, voiceId: selectedVoiceId }, generated) : null;
      if (!next || (promptVersions.current[requestId] ?? 0) !== promptVersion) {
        setNotice({ text: "Text sa počas vytvárania zmenil. Nahrávku vytvorte znova pre aktuálny text.", tone: "warning" });
        return;
      }
      liveDrafts.current = { ...liveDrafts.current, [selectedLineId]: next };
      setDrafts((previous) => ({ ...previous, [selectedLineId]: next }));
      setAudioErrors((previous) => ({ ...previous, [requestId]: "" }));
      const definition = ANNOUNCEMENT_DEFINITIONS.find((entry) => entry.key === key)!;
      setNotice({ text: definition.runtimeStatus === "prepared" ? "Nahrávka je pripravená na vypočutie a uloženie. Táto situácia zatiaľ nie je zapojená do hovorov; uloženie ju nezapne." : !isAnnouncementEnabled(next, key) ? "Nahrávka je pripravená na vypočutie a uloženie. Hláška zostáva v hovoroch vypnutá." : `Nahrávka pre linku ${line.label} (${LANGUAGE_LABELS[language]}) je pripravená na vypočutie. Do hovorov ju použijete uložením zmien.`, tone: "success" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nahrávku sa nepodarilo vytvoriť. Skúste to znova.");
    } finally {
      if (token === generationSequence.current) setGenerating(null);
    }
  }

  async function save() {
    if (!line || !config || !canEdit || saving || generating || !dirty || conflict || emptyLanguages.length > 0) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved: AnnouncementLine = await saveAnnouncements(line, config);
      setResponse((previous) => previous ? { ...previous, lines: previous.lines.map((entry) => entry.id === saved.id ? saved : entry) } : previous);
      setDrafts((previous) => ({ ...previous, [saved.id]: saved.config }));
      setNotice({ text: `Uložené pre linku ${saved.label}. Nové hovory použijú jazyk ${LANGUAGE_LABELS[saved.config.language]} a používané hlášky. Pripravené situácie zostávajú neaktívne.`, tone: "success" });
    } catch (caught) {
      setConflict(caught instanceof AnnouncementRequestError && caught.code === "stale_document");
      setError(caught instanceof Error ? caught.message : "Zmeny sa nepodarilo uložiť. Rozpísané hlášky zostali zachované.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section ref={panelRef} className="min-w-0 rounded-md border border-zinc-200 bg-white [&>div:first-child]:rounded-t-md">
      <SettingsSectionHeader icon={AudioLines} title="Hlášky a jazyk" description="Krátke a zrozumiteľné hlášky, ktoré volajúceho prevedú hovorom." />
      <div className="grid gap-4 p-4 sm:p-5">
        {loading && !response && <p className="flex items-center gap-2 py-4 text-sm text-zinc-600"><Loader2 size={16} className="animate-spin" aria-hidden="true" />Načítavam hlášky…</p>}
        {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
        {conflict && <div className="grid gap-2 text-xs text-zinc-600"><p>Načítajte aktuálnu verziu linky a skontrolujte svoj návrh pred ďalším uložením. Rozpísané hlášky zostanú zachované.</p><div><button type="button" className={buttonClass} disabled={loading} onClick={() => { setLoading(true); setReloadToken((value) => value + 1); }}><RefreshCw size={14} aria-hidden="true" />Načítať aktuálnu verziu linky</button></div></div>}
        {notice && <SettingsNotice tone={notice.tone}>{notice.text}</SettingsNotice>}
        {!loading && !response && <div><button type="button" className={buttonClass} onClick={() => { setLoading(true); setReloadToken((value) => value + 1); }}><RefreshCw size={14} aria-hidden="true" />Skúsiť znova</button></div>}
        {response && response.lines.length === 0 && <p className="rounded-md bg-zinc-50 p-4 text-sm text-zinc-600">Najprv pridajte telefónnu linku v nastaveniach čísel. Potom jej tu nastavíte hlášky.</p>}
        {response && line && config && (
          <>
            {!canEdit && <SettingsNotice>Máte prístup na čítanie. Hlášky môže upraviť správca alebo manažér.</SettingsNotice>}
            <div className="grid gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 sm:grid-cols-2">
              <SettingsField label="Telefónna linka" hint="Každá linka má vlastný jazyk a hlášky.">
                <select className={settingsInputClass} value={line.id} disabled={saving} onChange={(event) => { setLineId(event.target.value); setNotice(null); setError(null); }}>
                  {response.lines.map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · {entry.phoneNumber}{drafts[entry.id] && !sameAnnouncementConfig(entry.config, drafts[entry.id]) ? " • neuložené" : ""}</option>)}
                </select>
              </SettingsField>
              <SettingsField label="Jazyk hovoru" hint={`Teraz na linke: ${LANGUAGE_LABELS[line.config.language]}. Zvolený jazyk sa použije po uložení.`}>
                <select className={settingsInputClass} value={config.language} disabled={!canEdit || saving} onChange={(event) => updateConfig({ ...config, language: event.target.value as AnnouncementLanguage })}>
                  {ANNOUNCEMENT_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}
                </select>
              </SettingsField>
            </div>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-zinc-600">
              <span className="inline-flex items-center gap-1.5"><Globe2 size={14} aria-hidden="true" />Texty upravujete v jazyku {LANGUAGE_LABELS[config.language]}</span>
              <span className="inline-flex items-center gap-1.5"><Clock3 size={14} aria-hidden="true" />Dĺžka je orientačná</span>
              <span className="inline-flex items-center gap-1.5"><Headphones size={14} aria-hidden="true" />Pred uložením si nahrávku vypočujte</span>
            </div>

            <div className="flex flex-col gap-3 rounded-md border border-zinc-200 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2.5">
                <Mic2 size={18} className="mt-0.5 shrink-0 text-zinc-500" aria-hidden="true" />
                <div><h3 className="text-sm font-semibold text-zinc-900">Hlas nahrávok</h3><p className="mt-0.5 text-xs text-zinc-500">Po zmene hlasu vytvorte nahrávky nižšie. Bez nahrávky sa použije telefónny hlas.</p></div>
              </div>
              <select aria-label="Hlas pre nové nahrávky" className={`${settingsInputClass} sm:max-w-64`} value={config.voiceId} disabled={!canEdit || saving || Boolean(generating)} onChange={(event) => updateConfig({ ...config, voiceId: event.target.value })}>
                {ANNOUNCEMENT_VOICES.map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
              </select>
            </div>
            {!response.generationAvailable && <SettingsNotice tone="warning">Vytváranie hlasu zatiaľ nie je pripojené. Texty môžete upravovať a uložiť; používané hlášky bez nahrávky prečíta telefónny hlas.</SettingsNotice>}

            <div className="grid gap-3">
              <div><h3 className="text-sm font-semibold text-zinc-900">Knižnica hlášok</h3><p className="mt-1 text-xs leading-relaxed text-zinc-500">{ANNOUNCEMENT_DEFINITIONS.length} situácií · {ANNOUNCEMENT_LANGUAGES.length} jazyky. Do hovorov je zapojených {ANNOUNCEMENT_DEFINITIONS.filter((item) => item.runtimeStatus === "active" && isAnnouncementEnabled(config, item.key)).length} hlášok; {ANNOUNCEMENT_DEFINITIONS.filter((item) => item.runtimeStatus === "prepared").length} pripravených si môžete vopred upraviť a vypočuť. Prehrávanie závisí od situácie a zapnutých funkcií.</p></div>
              <div role="group" aria-label="Kategórie hlášok" className="flex flex-wrap gap-2">
                {ANNOUNCEMENT_CATEGORIES.map((item) => <button key={item.key} type="button" aria-pressed={category === item.key} className={`${buttonClass} ${category === item.key ? "border-yellow-400 bg-yellow-50 text-zinc-950" : ""}`} onClick={() => { panelRef.current?.querySelectorAll("audio").forEach((audio) => audio.pause()); setCategory(item.key); }}>{item.label}<span className="rounded bg-zinc-100 px-1.5 py-0.5 tabular-nums text-zinc-600">{ANNOUNCEMENT_DEFINITIONS.filter((definition) => definition.category === item.key).length}</span></button>)}
              </div>
              {category !== "active" && <SettingsNotice>Pripravené hlášky sa zatiaľ volajúcim neprehrávajú. Môžete ich upraviť, pregenerovať a uložiť; ich použitie v hovoroch tým nezapnete.</SettingsNotice>}
              {category === "recording" && <div className="flex items-start gap-2.5 rounded-md border border-zinc-200 bg-zinc-50 p-3"><ShieldCheck size={18} className="mt-0.5 shrink-0 text-zinc-500" aria-hidden="true" /><div><h3 className="text-sm font-semibold text-zinc-900">Oznámenia k nahrávaniu</h3><p className="mt-1 max-w-3xl text-xs leading-relaxed text-zinc-600">Zapnutie a aktuálnu pripravenosť nájdete v nastaveniach Nahrávanie a kvalita. Oznámenie pre vybavenie pomoci alebo aj kontrolu kvality sa vyberá podľa schválených účelov nahrávania. Obe verzie môžete upraviť; text musí zodpovedať prevádzkovateľovi a zapnutým účelom. Uloženie samotného textu nahrávanie nezapne.</p></div></div>}
              {category === "recording" && <div className="rounded-md border border-zinc-200 bg-white p-3 sm:p-4">
                <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4">
                  <span className="min-w-0"><span className="block text-sm font-semibold text-zinc-900">Hlášky o zmenách nahrávania</span><span id={`recording-status-hint-${line.id}`} className="mt-1 block text-xs leading-relaxed text-zinc-500">Oznámi volajúcemu vypnutie a obnovenie nahrávania. Platí pre všetky jazyky tejto linky.</span></span>
                  <input type="checkbox" role="switch" aria-label="Hlášky o zmenách nahrávania" aria-describedby={`recording-status-hint-${line.id}`} checked={config.recordingStatusAnnouncements === true} disabled={!canEdit || saving} onChange={(event) => updateConfig({ ...config, recordingStatusAnnouncements: event.target.checked })} className="h-5 w-5 shrink-0 cursor-pointer accent-zinc-900 disabled:cursor-not-allowed" />
                </label>
                <p className="mt-3 border-t border-zinc-100 pt-3 text-xs leading-relaxed text-zinc-600"><strong>{config.recordingStatusAnnouncements === true ? "Zapnuté." : "Vypnuté."}</strong> Úvodný oznam o nahrávaní sa prehrá aj pri vypnutom prepínači.</p>
              </div>}
            </div>

            <div className="grid min-w-0 gap-3 lg:grid-cols-2">
              {ANNOUNCEMENT_DEFINITIONS.filter((definition) => definition.category === category).map(({ key }, index) => renderPrompt(key, index + 1))}
            </div>

            <div className="grid gap-3 rounded-md border border-zinc-200 p-3 sm:grid-cols-[1fr_minmax(0,320px)] sm:items-center sm:p-4">
              <div className="flex items-start gap-2.5"><Headphones size={18} className="mt-0.5 shrink-0 text-zinc-500" aria-hidden="true" /><div><h3 className="text-sm font-semibold text-zinc-900">Hudba počas čakania</h3><p className="mt-1 text-xs leading-relaxed text-zinc-500">Pokojná inštrumentálna slučka počas čakania na dispečera.</p></div></div>
              <audio className="h-10 w-full min-w-0" controls preload="none" src="/telephony/announcements-v1/moh.mp3" aria-label="Vypočuť hudbu počas čakania" onPlay={(event) => pauseOtherPreviews(event.currentTarget)} onError={() => setAudioErrors((previous) => ({ ...previous, music: "Hudbu sa nepodarilo načítať. Skontrolujte pripojenie." }))} />
              {audioErrors.music && <p role="alert" className="text-xs text-red-700 sm:col-span-2">{audioErrors.music}</p>}
            </div>

            <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex flex-col gap-3 rounded-b-md border-t border-zinc-200 bg-white px-4 py-3 shadow-[0_-4px_12px_-8px_rgba(0,0,0,0.2)] sm:-mx-5 sm:-mb-5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div className="text-xs text-zinc-600">
                <p className={`flex items-center gap-1.5 font-semibold ${dirty ? "text-amber-700" : "text-emerald-700"}`}>{dirty ? <><span className="h-1.5 w-1.5 rounded-full bg-amber-500" />Neuložené zmeny pre túto linku</> : <><Check size={14} aria-hidden="true" />Nastavenia sú uložené</>}</p>
                <p className="mt-1">Zvolený jazyk a používané hlášky platia pre nové hovory. Pripravené zostanú neaktívne.</p>
                {emptyLanguages.length > 0 && <p className="mt-1 text-red-700">Doplňte prázdne hlášky: {emptyLanguages.map((language) => LANGUAGE_LABELS[language]).join(", ")}.</p>}
              </div>
              <button type="button" onClick={() => void save()} disabled={!canEdit || !dirty || saving || Boolean(generating) || conflict || emptyLanguages.length > 0} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-md bg-[#FCD703] px-5 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-yellow-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-950 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-500">
                {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}{saving ? "Ukladám…" : "Uložiť hlášky a jazyk"}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );

  function pauseOtherPreviews(playing: HTMLAudioElement) {
    panelRef.current?.querySelectorAll("audio").forEach((audio) => { if (audio !== playing) audio.pause(); });
  }

  function renderPrompt(key: AnnouncementKey, index?: number) {
    if (!line || !config) return null;
    const prompt = resolveAnnouncement(config, key);
    const definition = ANNOUNCEMENT_DEFINITIONS.find((entry) => entry.key === key)!;
    const promptId = `${line.id}:${config.language}:${key}`;
    const fieldId = `announcement-${line.id}-${config.language}-${key}`;
    const isGenerating = generating === promptId;
    const empty = prompt.text.trim().length === 0;
    const audioUrl = prompt.audioUrl;
    const enabled = isAnnouncementEnabled(config, key);
    return (
      <article key={promptId} className={`min-w-0 rounded-md border border-zinc-200 bg-white p-3 sm:p-4 ${key === "greeting" ? "lg:col-span-2" : ""}`}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            {index && <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-yellow-50 text-xs font-semibold text-yellow-800">{index}</span>}
            <div><label htmlFor={fieldId} className="text-sm font-semibold text-zinc-900">{definition.label}</label><span className={`mt-1 block w-fit rounded px-1.5 py-0.5 text-[11px] font-medium ${definition.runtimeStatus === "active" && enabled ? "bg-emerald-50 text-emerald-800" : "bg-zinc-100 text-zinc-600"}`}>{definition.runtimeStatus === "prepared" ? "Pripravené · neaktívne" : enabled ? "Používa sa v hovoroch" : "Vypnuté v hovoroch"}</span><p id={`${fieldId}-purpose`} className="mt-1 text-xs leading-relaxed text-zinc-500">{definition.description}</p></div>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-zinc-100 px-2 py-1 text-xs font-medium tabular-nums text-zinc-600"><Clock3 size={12} aria-hidden="true" />{empty ? "0 s" : `≈ ${estimatedAnnouncementSeconds(prompt.text)} s`}</span>
        </div>
        <textarea id={fieldId} lang={config.language} aria-describedby={`${fieldId}-purpose ${fieldId}-hint`} aria-invalid={empty} className="min-h-20 w-full resize-y rounded-md border border-zinc-200 bg-zinc-50/50 px-3 py-2.5 text-sm leading-relaxed text-zinc-800 outline-none ring-yellow-300 transition focus:bg-white focus:ring-2 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500" rows={2} maxLength={MAX_ANNOUNCEMENT_TEXT} value={prompt.text} disabled={!canEdit || saving} onChange={(event) => updateText(key, event.target.value)} />
        <div id={`${fieldId}-hint`} className="mt-1 flex items-start justify-between gap-3 text-xs"><span className={empty ? "text-red-700" : "text-zinc-500"}>{empty ? "Doplňte text hlášky." : definition.runtimeStatus === "prepared" ? "Pripravený návrh. Zatiaľ sa volajúcim neprehráva." : !enabled ? "Hláška je vypnutá. Text aj nahrávka zostávajú pripravené." : audioUrl ? "K textu je pripravená hlasová nahrávka." : "Bez nahrávky text počas hovoru prečíta telefónny hlas."}</span><span className="shrink-0 tabular-nums text-zinc-400">{prompt.text.length}/{MAX_ANNOUNCEMENT_TEXT}</span></div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void generate(key)} disabled={!canEdit || !response?.generationAvailable || saving || Boolean(generating) || empty} className={buttonClass}><Sparkles size={14} aria-hidden="true" className={isGenerating ? "hidden" : ""} />{isGenerating && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{isGenerating ? "Vytváram nahrávku…" : audioUrl ? "Pregenerovať nahrávku" : "Vytvoriť nahrávku"}</button>
          <button type="button" onClick={() => resetPrompt(key)} disabled={!canEdit || saving} className={buttonClass} aria-label={`Obnoviť odporúčaný text: ${definition.label}`}><RotateCcw size={14} aria-hidden="true" />Odporúčaný text</button>
        </div>
        {audioUrl && <div className="mt-3 rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2"><span className="mb-1.5 block text-xs font-medium text-zinc-600">Vypočuť hlášku</span><audio key={audioUrl} className="h-10 w-full min-w-0" controls preload="none" src={audioUrl} aria-label={`Vypočuť: ${definition.label}`} onPlay={(event) => pauseOtherPreviews(event.currentTarget)} onError={() => setAudioErrors((previous) => ({ ...previous, [promptId]: "Nahrávku sa nepodarilo prehrať. Skontrolujte pripojenie alebo ju vytvorte znova." }))}><a href={audioUrl}>Otvoriť nahrávku</a></audio>{audioErrors[promptId] && <p role="alert" className="mt-1 text-xs text-red-700">{audioErrors[promptId]}</p>}</div>}
      </article>
    );
  }
}
