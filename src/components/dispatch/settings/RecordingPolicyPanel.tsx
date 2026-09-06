"use client";

import { useEffect, useState } from "react";
import { AudioLines, Save } from "lucide-react";
import type { RecordingPolicyDocument, RecordingPolicyResponse } from "@/lib/telephony/recording-quality";
import { isTelephonyTimeout } from "@/lib/telephony/client-request";
import { RecordingRequestError, recordingErrorMessage, recordingRequest } from "../recordings/recording-client";
import { RecordingLoading, RecordingMessage, recordingButtonClass, recordingInputClass } from "../recordings/recording-ui";
import { SettingsField, SettingsSectionHeader } from "./settings-ui";

const endpoint = "/api/telephony/config/recording-policy";
const scopeFields = ["controllerName", "contactEmail", "privacyNoticeUrl", "serviceLegalBasis", "qualityLegalBasis", "audioRetentionDays", "transcriptRetentionDays", "reviewRetentionDays"] as const;
const switches = ["recordingEnabled", "transcriptionEnabled", "analysisEnabled", "qualityEnabled", "inboundEnabled", "outboundEnabled"] as const;

export function RecordingPolicyPanel({ onOpenAnnouncements }: { onOpenAnnouncements?: () => void }) {
  const [server, setServer] = useState<RecordingPolicyResponse | null>(null);
  const [draft, setDraft] = useState<RecordingPolicyDocument | null>(null);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [conflict, setConflict] = useState(false); const [approvePolicy, setApprovePolicy] = useState(false); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void recordingRequest<RecordingPolicyResponse>(endpoint, { signal: controller.signal }).then((result) => { if (!controller.signal.aborted) { setServer(result); setDraft(result.policy); } }).catch((caught) => { if (!controller.signal.aborted) setError(recordingErrorMessage(caught)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  async function reload() {
    setBusy(true); setError(null);
    try { const fresh = await recordingRequest<RecordingPolicyResponse>(endpoint); setServer(fresh); setDraft((current) => current ? { ...current, revision: fresh.policy.revision, approvedAt: fresh.policy.approvedAt } : fresh.policy); setConflict(false); setApprovePolicy(false); setNotice("Načítaná aktuálna verzia. Rozpracované úpravy zostali zachované; pred uložením ich skontrolujte."); }
    catch (caught) { setError(recordingErrorMessage(caught)); } finally { setBusy(false); }
  }
  function change(patch: Partial<RecordingPolicyDocument>) { setDraft((current) => current ? { ...current, ...patch } : current); setApprovePolicy(false); setNotice(null); }
  async function save() {
    if (!draft || !server?.canEdit || busy || conflict) return;
    setBusy(true); setError(null); setNotice(null);
    try { const fresh = await recordingRequest<RecordingPolicyResponse>(endpoint, { method: "PUT", body: { policy: draft, approvePolicy } }); setServer(fresh); setDraft(fresh.policy); setApprovePolicy(false); setNotice("Nastavenia sú uložené. Nové hovory použijú uloženú konfiguráciu; už prebiehajúci hovor má svoju pôvodnú verziu."); }
    catch (caught) { setError(recordingErrorMessage(caught)); if ((caught instanceof RecordingRequestError && caught.code === "stale_recording_policy") || isTelephonyTimeout(caught)) setConflict(true); }
    finally { setBusy(false); }
  }
  if (loading) return <RecordingLoading label="Načítavam nastavenia nahrávania…" />;
  if (!draft || !server) return <div className="space-y-3"><RecordingMessage error>{error ?? "Nastavenia nie sú dostupné."}</RecordingMessage><button type="button" onClick={() => void reload()} disabled={busy} className={recordingButtonClass}>Skúsiť znova</button></div>;
  const disabled = !server.canEdit || busy;
  const needsApproval = !server.policy.approvedAt || scopeFields.some((field) => draft[field] !== server.policy[field]) || switches.some((field) => draft[field] && !server.policy[field]);
  const dependenciesInvalid = (draft.transcriptionEnabled && !draft.recordingEnabled) || (draft.analysisEnabled && !draft.transcriptionEnabled) || (draft.qualityEnabled && !draft.analysisEnabled);
  const activationBlocked = (draft.recordingEnabled && !server.readiness.recording) || (draft.transcriptionEnabled && !server.readiness.transcription) || (draft.analysisEnabled && !server.readiness.analysis);
  return <section className="min-w-0 rounded-md border border-zinc-200 bg-white">
    <SettingsSectionHeader icon={AudioLines} title="Nahrávanie a kvalita" description="Čo sa zaznamená, kto údaje spracúva a ako dlho zostanú dostupné." />
    <form className="min-w-0 space-y-5 p-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {!server.canEdit && <RecordingMessage>Nastavenia môže upravovať manažér alebo administrátor.</RecordingMessage>}
      <div className="grid gap-3 sm:grid-cols-2">{[
        ["recordingEnabled", "Nahrávať hovory", "Vytvorí záznam zákazníckeho rozhovoru po oznámení."], ["transcriptionEnabled", "Vytvárať časový prepis", "Prepis v pôvodnom jazyku zo zaznamenaných úsekov."], ["analysisEnabled", "AI súhrn a zistené údaje", "Téma, dôvod, výsledok a dohodnuté kroky."], ["qualityEnabled", "Návrh hodnotenia operátora", "Sedem kritérií s dôkazmi a následnou ľudskou kontrolou."],
      ].map(([field, label, hint]) => <label key={field} className="flex min-w-0 items-start gap-3 rounded-md border border-zinc-200 p-3"><input type="checkbox" checked={draft[field as keyof RecordingPolicyDocument] as boolean} disabled={disabled} onChange={(event) => change({ [field]: event.target.checked })} className="mt-1 h-4 w-4 shrink-0 accent-yellow-400" /><span className="min-w-0"><span className="block text-sm font-semibold text-zinc-900">{label}</span><span className="mt-1 block text-xs leading-5 text-zinc-500">{hint}</span></span></label>)}</div>
      {dependenciesInvalid && <RecordingMessage error>Prepis potrebuje nahrávanie; AI súhrn potrebuje prepis a hodnotenie potrebuje AI analýzu. Zapnite potrebné kroky alebo vypnite závislé funkcie.</RecordingMessage>}
      <div className="flex flex-wrap gap-4"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.inboundEnabled} disabled={disabled} onChange={(event) => change({ inboundEnabled: event.target.checked })} />Prichádzajúce hovory</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.outboundEnabled} disabled={disabled} onChange={(event) => change({ outboundEnabled: event.target.checked })} />Odchádzajúce hovory</label></div>
      {server.readiness.reasons.length > 0 && <RecordingMessage><span className="block font-semibold">Pripravenosť zapojenia</span>{server.readiness.reasons.map((reason, index) => <span key={index} className="mt-1 block">{reason}</span>)}</RecordingMessage>}
      <div className="grid gap-3 sm:grid-cols-2">
        <SettingsField label="Prevádzkovateľ"><input className={recordingInputClass} value={draft.controllerName} disabled={disabled} required={draft.recordingEnabled} maxLength={2000} onChange={(event) => change({ controllerName: event.target.value })} /></SettingsField>
        <SettingsField label="Kontaktný e-mail"><input className={recordingInputClass} type="email" value={draft.contactEmail} disabled={disabled} required={draft.recordingEnabled} maxLength={2000} onChange={(event) => change({ contactEmail: event.target.value })} /></SettingsField>
        <div className="sm:col-span-2"><SettingsField label="Informácie o spracovaní údajov" hint="Úplný informačný dokument pre volajúcich; zabezpečená adresa https://."><input className={recordingInputClass} type="url" pattern="https://.*" value={draft.privacyNoticeUrl} disabled={disabled} required={draft.recordingEnabled} maxLength={2000} onChange={(event) => change({ privacyNoticeUrl: event.target.value })} /></SettingsField></div>
        <SettingsField label="Účel a právny základ vybavenia pomoci"><textarea aria-label="Účel a právny základ vybavenia pomoci" className={`${recordingInputClass} min-h-24`} value={draft.serviceLegalBasis} disabled={disabled} required={draft.recordingEnabled} maxLength={2000} onChange={(event) => change({ serviceLegalBasis: event.target.value })} /></SettingsField>
        <SettingsField label="Účel a právny základ kontroly kvality"><textarea aria-label="Účel a právny základ kontroly kvality" className={`${recordingInputClass} min-h-24`} value={draft.qualityLegalBasis} disabled={disabled} required={draft.qualityEnabled} maxLength={2000} onChange={(event) => change({ qualityLegalBasis: event.target.value })} /></SettingsField>
      </div>
      <fieldset className="space-y-3"><legend className="mb-2 text-sm font-semibold text-zinc-900">Uchovanie a limity</legend><div className="grid gap-3 sm:grid-cols-3">{([
        ["audioRetentionDays", "Nahrávky (dni)", 1, 365], ["transcriptRetentionDays", "Prepisy (dni)", 1, 365], ["reviewRetentionDays", "Hodnotenia (dni)", 1, 365], ["maxRecordingsPerHour", "Nové záznamy za hodinu", 1, 10], ["maxSegmentSeconds", "Najdlhší úsek (sekundy)", 1, 1800],
      ] as const).map(([field, label, min, max]) => <SettingsField key={field} label={label}><input className={recordingInputClass} type="number" min={min} max={max} step={1} required disabled={disabled} value={Number.isFinite(draft[field]) ? draft[field] : ""} onChange={(event) => change({ [field]: event.target.valueAsNumber })} /></SettingsField>)}<SettingsField label="Najväčší záznam (MiB)"><input className={recordingInputClass} type="number" min={1} max={128} step={1} required disabled={disabled} value={Number.isFinite(draft.maxRecordingBytes) ? draft.maxRecordingBytes / 1048576 : ""} onChange={(event) => change({ maxRecordingBytes: event.target.valueAsNumber * 1048576 })} /></SettingsField></div><p className="text-xs text-zinc-500">Lehoty sú nastavením organizácie. Vypnutie nového nahrávania samo neodstraňuje staršie záznamy; ich dostupnosť riadia oprávnenia a uchovanie.</p></fieldset>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-zinc-50 p-3"><div><p className="text-sm font-semibold">Hlášky a jazyk linky</p><p className="mt-1 text-xs text-zinc-600">Slovenčina, čeština, angličtina a nemčina. Oznámenie musí zodpovedať uloženým účelom.</p></div>{onOpenAnnouncements && <button type="button" className={recordingButtonClass} onClick={onOpenAnnouncements}>Upraviť hlášky a jazyk</button>}</div>
      {server.canEdit && needsApproval && <label className="flex items-start gap-2 rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm"><input type="checkbox" checked={approvePolicy} disabled={busy} onChange={(event) => setApprovePolicy(event.target.checked)} className="mt-1 shrink-0" /><span>Potvrdzujem správnosť účelov, informovania účastníkov a lehôt uchovania pre tieto nastavenia. Zmenu účelu kontroly kvality sme zohľadnili aj v oznámení.</span></label>}
      {error && <RecordingMessage error>{error}</RecordingMessage>}{notice && <RecordingMessage>{notice}</RecordingMessage>}
      {conflict && <><RecordingMessage>Vaše úpravy zostali zachované. Uloženie je pozastavené do načítania aktuálnej verzie.</RecordingMessage><button type="button" className={recordingButtonClass} disabled={busy} onClick={() => void reload()}>Načítať verziu a zachovať úpravy</button></>}
      <div className="flex flex-wrap items-center gap-3"><button type="submit" className={`${recordingButtonClass} border-yellow-400 bg-yellow-300`} disabled={disabled || conflict || dependenciesInvalid || activationBlocked || (draft.recordingEnabled && needsApproval && !approvePolicy)}><Save size={15} />{busy ? "Ukladám…" : "Uložiť nahrávanie a kvalitu"}</button><span className="text-xs text-zinc-500">Verzia {draft.revision}{server.policy.approvedAt ? ` · potvrdená ${new Date(server.policy.approvedAt).toLocaleDateString("sk-SK")}` : " · zatiaľ nepotvrdená"}</span></div>
    </form>
  </section>;
}
