"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Clock3, Loader2, Save, Settings2, Undo2 } from "lucide-react";
import type { DraftEditorState } from "../useDraftEditors";
import type { RoutingDocument } from "@/server/telephony/config-service";
import type { RoutingNavigationTarget } from "@/lib/telephony/routing-summary";
import { parseIncomingFlow, type IncomingFlow } from "@/lib/telephony/incoming-flow";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import { ConfigRequestError, loadRoutingConfig, saveRoutingConfig, type RoutingConfigResponse } from "./config-client";
import { initialIncomingLineId } from "./incoming-routing-model";
import { emptyIncomingFlow, incomingFlowChanges, incomingFlowsMatch, incomingFlowSummary, legacyIncomingFlow, validateIncomingFlowDraft, type FlowDrafts } from "./incoming-flow-model";
import { IncomingFlowSteps } from "./IncomingFlowSteps";
import { LegacyIncomingRoutingEditor } from "./LegacyIncomingRoutingEditor";
import { SettingsIssueList, SettingsNotice } from "./settings-ui";
import styles from "./incoming-flow.module.css";

export type IncomingEditorActions = { save: () => Promise<boolean>; discard: () => void };
type Props = {
  document: RoutingDocument; canEdit: boolean; target?: RoutingNavigationTarget | null;
  onSaved: (response: RoutingConfigResponse) => void;
  onNavigate: (target: RoutingNavigationTarget) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onActionsChange?: (actions: IncomingEditorActions | null) => void;
  onEditorStateChange?: (state: DraftEditorState | null) => void;
};

/** Existing databases and complex legacy routes retain their original, guarded editor. */
export function IncomingRoutingEditor(props: Props) {
  const [legacy, setLegacy] = useState(Boolean((props.target?.planId || props.target?.groupId) && !props.target?.lineId));
  const [legacyPending, setLegacyPending] = useState(false);
  const [legacyLineId, setLegacyLineId] = useState<string | null>(null);
  const [previousTarget, setPreviousTarget] = useState(props.target);
  const parentEditorStateChange = props.onEditorStateChange;
  const handleLegacyState = useCallback((state: DraftEditorState | null) => {
    setLegacyPending(Boolean(state?.dirty || state?.saving));
    parentEditorStateChange?.(state);
  }, [parentEditorStateChange]);
  const legacyTarget = useMemo(() => legacyLineId ? { section: "telephony" as const, tab: "incoming" as const, lineId: legacyLineId } : props.target, [legacyLineId, props.target]);
  if (props.target !== previousTarget) {
    setPreviousTarget(props.target);
    if (props.target?.planId || props.target?.groupId) setLegacy(true);
    else if (props.target?.lineId) setLegacy(false);
  }
  if (!props.document.capabilities?.unifiedIncomingFlow) return <LegacyIncomingRoutingEditor {...props} />;
  if (legacy) return <div className="grid min-w-0 gap-3">
    <div><button type="button" disabled={legacyPending} className={styles.button} onClick={() => setLegacy(false)}><ArrowLeft size={16} aria-hidden="true" />Späť na postup hovoru</button>{legacyPending && <p className={styles.note}>Pred návratom ulož alebo zahoď rozpracované zmeny.</p>}</div>
    <LegacyIncomingRoutingEditor {...props} target={legacyTarget} onEditorStateChange={handleLegacyState} />
  </div>;
  return <UnifiedIncomingRoutingEditor {...props} onLegacy={lineId => { setLegacyLineId(lineId); setLegacy(true); }} />;
}

function UnifiedIncomingRoutingEditor({ document, canEdit, target, onSaved, onNavigate, onDirtyChange, onActionsChange, onEditorStateChange, onLegacy }: Props & { onLegacy: (lineId: string) => void }) {
  const [baseline, setBaseline] = useState(document);
  const [drafts, setDrafts] = useState<FlowDrafts>({});
  const [lineId, setLineId] = useState(() => initialIncomingLineId(document, target));
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [remote, setRemote] = useState<RoutingDocument | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rememberedNumbers, setRememberedNumbers] = useState<Record<string, string>>({});
  const [previousTarget, setPreviousTarget] = useState(target);
  if (target !== previousTarget) {
    setPreviousTarget(target);
    if (target?.lineId) setLineId(initialIncomingLineId(baseline, target));
  }
  const changes = useMemo(() => incomingFlowChanges(drafts, baseline), [drafts, baseline]);
  const dirty = changes.length > 0;
  const pendingChanges = useRef(false);
  useEffect(() => { pendingChanges.current = dirty || saving || uncertain; }, [dirty, saving, uncertain]);
  const line = baseline.lines.find(candidate => candidate.id === lineId) ?? baseline.lines[0];
  const lineIndex = line ? baseline.lines.indexOf(line) : -1;
  const legacy = useMemo(() => line ? legacyIncomingFlow(baseline, line) : null, [baseline, line]);
  const flow = line ? drafts[line.id] ?? line.incomingFlow ?? legacy?.flow ?? null : null;
  const usingLegacy = Boolean(line && !drafts[line.id] && !line.incomingFlow);
  const locked = !canEdit || saving || uncertain || Boolean(remote);
  const issues = useMemo(() => changes.flatMap(change => validateIncomingFlowDraft(change.flow, { ...baseline, lines: baseline.lines.map(candidate => ({ ...candidate, incomingFlow: drafts[candidate.id] ?? candidate.incomingFlow })) }).map(issue => ({ ...issue, path: `${change.id}.${issue.path}`, message: `${baseline.lines.find(candidate => candidate.id === change.id)?.label ?? "Linka"}: ${issue.message}` }))), [changes, baseline, drafts]);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty && !uncertain) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, uncertain]);
  function updateFlow(next: IncomingFlow) {
    if (!line || locked) return;
    pendingChanges.current = true;
    setDrafts(current => ({ ...current, [line.id]: next })); setError(null); setNotice(null);
  }
  function accept(response: RoutingConfigResponse) {
    pendingChanges.current = false;
    setBaseline(response.document); setDrafts({}); setRememberedNumbers({}); setRemote(null); setUncertain(false); onSaved(response);
  }
  function discard() {
    pendingChanges.current = false;
    if (remote) setBaseline(remote);
    setDrafts({}); setRememberedNumbers({}); setRemote(null); setUncertain(false); setError(null); setNotice(null);
  }
  async function verify(): Promise<boolean> {
    try {
      const latest = await loadRoutingConfig("incoming");
      if (incomingFlowsMatch(changes, latest.document)) {
        accept(latest); setError(null); setNotice("Uložený stav je overený. Postupy zodpovedajú tvojim zmenám."); return true;
      }
      setRemote(latest.document); setUncertain(false);
      setError("Uložený stav sa líši. Tvoje zmeny zostávajú v návrhu; porovnaj ich pred ďalším uložením.");
    } catch { setUncertain(true); setError("Výsledok uloženia zatiaľ nemožno overiť. Návrh zostáva zachovaný. Najprv over uložený stav."); }
    return false;
  }
  async function save(): Promise<boolean> {
    if (locked || issues.length > 0 || !baseline.snapshotId) return false;
    if (!dirty) return true;
    let accepted = false;
    pendingChanges.current = true; setSaving(true); setError(null); setNotice(null);
    try {
      const response = await saveRoutingConfig("incomingFlow", { version: baseline.routingVersion, snapshotId: baseline.snapshotId, lines: changes.map(change => ({ ...change, flow: parseIncomingFlow(change.flow) })) });
      accept(response); accepted = true;
      setNotice(`Postupy sú uložené. Zmena platí pre nové hovory.${response.warning ? ` ${response.warning}` : ""}`);
      return true;
    } catch (caught) {
      if (caught instanceof ConfigRequestError && caught.status >= 400 && caught.status < 500) {
        setError([caught.message, ...caught.issues.map(issue => issue.message)].filter(Boolean).join(" "));
        if (caught.status === 409) {
          try { const latest = await loadRoutingConfig("incoming"); setRemote(latest.document); } catch { setUncertain(true); }
        }
        return false;
      }
      setUncertain(true); accepted = await verify(); return accepted;
    } finally { pendingChanges.current = !accepted && dirty; setSaving(false); }
  }
  async function verifySavedState() { if (saving) return; setSaving(true); try { await verify(); } finally { setSaving(false); } }
  useEffect(() => { onEditorStateChange?.({ dirty, saving, save, discard, hasPendingChanges: () => pendingChanges.current }); });
  useEffect(() => () => onEditorStateChange?.(null), [onEditorStateChange]);
  useEffect(() => { onActionsChange?.({ save, discard }); return () => onActionsChange?.(null); });
  function nextLine(direction: -1 | 1) {
    if (!baseline.lines.length) return;
    setLineId(baseline.lines[(lineIndex + direction + baseline.lines.length) % baseline.lines.length].id);
  }
  return <section className={styles.editor} aria-label="Prichádzajúce hovory">
    <header className={styles.heading}><h2>Cesta prichádzajúceho hovoru</h2><p>Ľudia v jednom kroku zvonia naraz. Jednotlivé kroky idú postupne.</p></header>
    {line ? <div className={styles.lineSelector}>
      <div className={styles.lineMain}><button type="button" className={styles.iconButton} disabled={baseline.lines.length < 2} onClick={() => nextLine(-1)} aria-label="Predchádzajúca linka"><ChevronLeft size={24} aria-hidden="true" /></button><div className={styles.lineIdentity} aria-live="polite"><p>{line.label}</p><strong>{formatPhoneNumberForDisplay(line.phoneNumber)}</strong><small>Linka {lineIndex + 1} z {baseline.lines.length}{!line.active ? " · Vypnutá" : ""}{drafts[line.id] && changes.some(change => change.id === line.id) ? " · Neuložené zmeny" : ""}</small></div><button type="button" className={styles.iconButton} disabled={baseline.lines.length < 2} onClick={() => nextLine(1)} aria-label="Nasledujúca linka"><ChevronRight size={24} aria-hidden="true" /></button></div>
      {baseline.lines.length > 1 && <nav className={styles.lineDots} aria-label="Vybrať linku">{baseline.lines.map(candidate => <button key={candidate.id} type="button" aria-current={candidate.id === line.id} aria-label={`${candidate.label}, ${formatPhoneNumberForDisplay(candidate.phoneNumber)}`} onClick={() => setLineId(candidate.id)}><span /></button>)}</nav>}
    </div> : <SettingsNotice>Nie je dostupná žiadna linka. Najprv ju pridaj v nastavení čísel.</SettingsNotice>}
    {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
    {notice && !dirty && <SettingsNotice tone="success">{notice}</SettingsNotice>}
    {uncertain && <button type="button" disabled={saving} onClick={() => void verifySavedState()} className={styles.button}>Overiť uložený stav</button>}
    {remote && <details open className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm"><summary className="min-h-11 cursor-pointer font-semibold">Porovnať uložené postupy a vlastný návrh</summary><div className="grid gap-4 md:grid-cols-2">{[{ title: "Aktuálne uložené", document: remote }, { title: "Tvoj zachovaný návrh", document: baseline }].map((entry, index) => <div key={entry.title}><h3 className="font-semibold">{entry.title}</h3>{changes.map(change => { const compared = entry.document.lines.find(candidate => candidate.id === change.id); const value = index === 1 ? change.flow : compared?.incomingFlow; return <p key={change.id} className="mt-2 break-words text-xs leading-6"><strong>{compared?.label ?? "Odstránená linka"}:</strong> {value ? incomingFlowSummary(value, entry.document) : compared ? "Pôvodné smerovanie podľa plánu" : "Linka už nie je dostupná"}</p>; })}</div>)}</div><p className="mt-3 text-xs">Pred novou úpravou načítaj uložený stav. Vlastné hodnoty si môžeš skopírovať zo zachovaného návrhu.</p><button type="button" className={`${styles.button} mt-3`} onClick={discard}>Zahodiť návrh a načítať uložené</button></details>}
    {line && usingLegacy && <div className={styles.legacyNotice}>
      <strong>{legacy?.flow ? "Uložené pôvodné smerovanie" : "Táto linka používa pôvodné nastavenie"}</strong>
      <p>{legacy?.reason ?? "Nižšie vidíš doterajšie poradie a časy. Voľba Aplikácia v novom postupe zahŕňa web aj mobilnú appku. Pôvodné smerovanie zostane aktívne až do uloženia."}</p>
      <div className={styles.links}>{legacy?.canReplace && <button type="button" disabled={locked} className={`${styles.button} ${styles.primary}`} onClick={() => updateFlow(structuredClone(legacy.flow ?? emptyIncomingFlow()))}>{legacy.flow ? "Upraviť tento postup" : "Pripraviť nový postup"}</button>}<button type="button" disabled={dirty || saving || uncertain} className={styles.textButton} onClick={() => onLegacy(line.id)}>Otvoriť pôvodné nastavenie</button></div>
      {dirty && <p>Pred otvorením pôvodného nastavenia ulož alebo zahoď rozpracované zmeny.</p>}
    </div>}
    {flow && <>
      <div className={styles.intro}><p><strong>{dirty && drafts[line!.id] ? "Návrh postupu:" : usingLegacy ? "Doterajšie poradie:" : "Postup hovoru:"}</strong> {incomingFlowSummary(flow, baseline)}</p><p className={styles.answerRule}><Check size={15} aria-hidden="true" />Keď niekto prijme hovor, ostatné zvonenia a ďalšie kroky sa zastavia.</p></div>
      <IncomingFlowSteps flow={flow} document={baseline} lineId={line!.id} disabled={locked || usingLegacy} onChange={updateFlow} rememberedNumbers={rememberedNumbers} rememberNumber={(key, number) => setRememberedNumbers(current => ({ ...current, [key]: number }))} />
      <p className={styles.note}>Zvonia iba dostupní operátori a pripojené zariadenia. Pauza, obsadenosť a kapacita organizácie sa uplatnia aj v tomto postupe.</p>
    </>}
    {line && <div className={styles.links}><button type="button" className={styles.textButton} onClick={() => onNavigate({ section: "telephony", tab: "numbers", lineId: line.id })}><Settings2 size={14} aria-hidden="true" />Nastavenie linky</button>{line.businessHoursId && <button type="button" className={styles.textButton} onClick={() => onNavigate({ section: "telephony", tab: "hours", lineId: line.id, businessHoursId: line.businessHoursId! })}><Clock3 size={14} aria-hidden="true" />Otváracie hodiny sa uplatnia pred postupom</button>}{line.ivrMenuId && <button type="button" className={styles.textButton} onClick={() => onNavigate({ section: "telephony", tab: "ivr", lineId: line.id, ivrMenuId: line.ivrMenuId! })}>Hlasové menu</button>}</div>}
    <div className={styles.saveBar} data-dirty={dirty}>
      <p role="status">{dirty ? <span className={styles.statusDot} /> : <Check size={15} aria-hidden="true" />}{dirty ? `Neuložené zmeny: ${changes.length} ${changes.length === 1 ? "linka" : changes.length < 5 ? "linky" : "liniek"}` : "Všetky zmeny sú uložené"}</p>
      <div className={styles.saveButtons}><button type="button" disabled={!dirty || saving || uncertain} className={styles.button} onClick={() => { if (window.confirm("Zahodiť všetky rozpracované zmeny postupov?")) discard(); }}><Undo2 size={15} aria-hidden="true" />Zahodiť</button><button type="button" disabled={locked || !dirty || issues.length > 0 || !baseline.snapshotId} className={`${styles.button} ${styles.primary}`} onClick={() => void save()}>{saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}Uložiť zmeny</button></div>
      {dirty && <small>Dotknuté linky: {changes.map(change => { const changed = baseline.lines.find(candidate => candidate.id === change.id); return `${changed?.label ?? "Linka"} (${formatPhoneNumberForDisplay(changed?.phoneNumber ?? "")})`; }).join(", ")}. Uloženie platí iba pre nové hovory.</small>}
      {!baseline.snapshotId && <small>Na bezpečné uloženie chýba aktuálny stav nastavení. Obnov stránku.</small>}
      {issues.length > 0 && <div className="basis-full"><SettingsIssueList issues={issues} /></div>}
    </div>
  </section>;
}
