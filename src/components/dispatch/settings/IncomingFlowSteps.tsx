"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, Clock3, Copy, MessageSquare, MonitorSmartphone, MoreHorizontal, Phone, Plus, Repeat2, Trash2, UsersRound, X, AlertTriangle } from "lucide-react";
import { MAX_INCOMING_FLOW_STEPS, type IncomingFlow, type IncomingFlowPerson, type IncomingFlowStep, type IncomingRingStep } from "@/lib/telephony/incoming-flow";
import { normalizeE164 } from "@/lib/telephony/normalize-e164";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import type { RoutingDocument } from "@/server/telephony/config-service";
import { FLOW_ENDINGS, incomingStepSummary, moveFlowStep, personalNumberIssue, removeFlowStep } from "./incoming-flow-model";
import styles from "./incoming-flow.module.css";

type DialogState = { kind: "people"; stepId: string } | { kind: "number"; stepId: string; profileId: string; number: string } | { kind: "ending" } | { kind: "remove"; stepId: string };
const stepNames = { ring: "Zvoniť ľuďom", wait: "Čakáreň", repeat: "Zopakovať zvonenie", external: "Zavolať na iné číslo" };
const stepIcons = { ring: UsersRound, wait: Clock3, repeat: Repeat2, external: Phone };
const eligible = (operator: RoutingDocument["operators"][number]) => operator.active && (!operator.accessStatus || operator.accessStatus === "active") && ["dispatcher", "senior_dispatcher", "manager", "admin"].includes(operator.role);
const initial = (name: string) => name.split(/\s+/).slice(0, 2).map(word => word[0]).join("");

function FlowDialog({ title, children, onClose, actions }: { title: string; children: ReactNode; onClose: () => void; actions?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} className={styles.dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className={styles.dialogHeader}><h3 id={titleId}>{title}</h3><button type="button" className={styles.iconButton} aria-label="Zavrieť" onClick={onClose}><X size={20} aria-hidden="true" /></button></div>
    <div className={styles.dialogBody}>{children}</div>
    {actions && <div className={styles.dialogActions}>{actions}</div>}
  </dialog>;
}

function PersonalNumberDialog({ name, number, profileId, document, onClose, onApply }: { name: string; number: string; profileId: string; document: RoutingDocument; onClose: () => void; onApply: (number: string) => void }) {
  const [value, setValue] = useState(number);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  function apply() {
    const issue = personalNumberIssue(value, document, profileId);
    setError(issue);
    if (!issue) onApply(normalizeE164(value)!);
  }
  return <FlowDialog title={`Osobné číslo · ${name}`} onClose={onClose} actions={<><button type="button" className={styles.button} onClick={onClose}>Zrušiť</button><button type="button" className={`${styles.button} ${styles.primary}`} onClick={apply}>Použiť a zapnúť</button></>}>
    <p>Na toto číslo príde bežný telefonický hovor.</p>
    <label className={styles.phoneLabel}>Telefónne číslo<input type="tel" inputMode="tel" autoComplete="off" maxLength={30} className={styles.phoneInput} value={value} onChange={event => { setValue(event.target.value); setError(null); }} aria-describedby={`${id}-help ${id}-error`} aria-invalid={Boolean(error)} placeholder="+421 910 123 456" onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); apply(); } }} /></label>
    <p id={`${id}-help`} className={styles.note}>Číslo a jeho zapnutie sa uložia spolu s postupom, iba pre tento krok. Predvolené číslo v profile operátora sa nemení.</p>
    <p id={`${id}-error`} role="alert" className={styles.error}>{error}</p>
  </FlowDialog>;
}

export function IncomingFlowSteps({ flow, document, lineId, disabled, onChange, rememberedNumbers, rememberNumber }: {
  flow: IncomingFlow; document: RoutingDocument; lineId: string; disabled: boolean; onChange: (flow: IncomingFlow) => void;
  rememberedNumbers: Record<string, string>; rememberNumber: (key: string, number: string) => void;
}) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [previousLine, setPreviousLine] = useState(lineId);
  if (previousLine !== lineId) { setPreviousLine(lineId); setDialog(null); setAddOpen(false); setNotice(null); }
  const memoryKey = (stepId: string, profileId: string) => `${lineId}:${stepId}:${profileId}`;
  const updateStep = (id: string, update: (step: IncomingFlowStep) => IncomingFlowStep) => {
    if (!disabled) onChange({ ...flow, steps: flow.steps.map(step => step.id === id ? update(step) : step) });
  };
  const updatePerson = (id: string, profileId: string, update: (person: IncomingFlowPerson) => IncomingFlowPerson) => updateStep(id, step => step.type === "ring" ? { ...step, people: step.people.map(person => person.profileId === profileId ? update(person) : person) } : step);
  function togglePerson(step: IncomingRingStep, person: IncomingFlowPerson, channel: "application" | "personalNumber") {
    setNotice(null);
    if (disabled) return;
    if ((channel === "application" && person.application && !person.personalNumber) || (channel === "personalNumber" && person.personalNumber && !person.application)) {
      setNotice("Ponechaj aspoň jeden spôsob zvonenia alebo človeka odstráň z kroku."); return;
    }
    if (channel === "application") updatePerson(step.id, person.profileId, current => ({ ...current, application: !current.application }));
    else if (person.personalNumber) {
      rememberNumber(memoryKey(step.id, person.profileId), person.personalNumber);
      updatePerson(step.id, person.profileId, current => ({ ...current, personalNumber: null }));
    } else {
      const number = rememberedNumbers[memoryKey(step.id, person.profileId)] ?? document.operators.find(operator => operator.profileId === person.profileId)?.settings?.defaultMobileNumber ?? "";
      if (personalNumberIssue(number, document, person.profileId)) setDialog({ kind: "number", stepId: step.id, profileId: person.profileId, number });
      else updatePerson(step.id, person.profileId, current => ({ ...current, personalNumber: normalizeE164(number) }));
    }
  }
  function move(id: string, direction: -1 | 1) {
    const next = moveFlowStep(flow, id, direction);
    if (next) { onChange(next); setNotice(null); }
    else setNotice("Opakovanie musí zostať za všetkými krokmi, ktoré opakuje. Najprv uprav jeho výber.");
  }
  function add(type: IncomingFlowStep["type"]) {
    if (disabled || flow.steps.length >= MAX_INCOMING_FLOW_STEPS) return;
    const id = crypto.randomUUID();
    let step: IncomingFlowStep;
    if (type === "ring") step = { id, type, seconds: 20, people: [] };
    else if (type === "wait") step = { id, type, minutes: 2 };
    else if (type === "external") step = { id, type, number: "", seconds: 25 };
    else step = { id, type, times: 1, stepIds: flow.steps.filter(candidate => candidate.type === "ring" || candidate.type === "external").map(candidate => candidate.id).slice(-2) };
    onChange({ ...flow, steps: [...flow.steps, step] }); setAddOpen(false);
    if (type === "ring") setDialog({ kind: "people", stepId: id });
  }
  const dialogStep = dialog && "stepId" in dialog ? flow.steps.find(step => step.id === dialog.stepId) : null;
  return <>
    {notice && <p role="status" className={styles.note}>{notice}</p>}
    <div className={styles.timeline}>
      {flow.steps.map((step, index) => {
        const Icon = stepIcons[step.type];
        return <article key={step.id} className={styles.step} aria-label={`Krok ${index + 1}: ${stepNames[step.type]}`}>
          <span className={styles.stepIndex} aria-hidden="true">{index + 1}</span>
          <div className={styles.stepCard}>
            <div className={styles.stepHeader}>
              <div className={styles.stepTitle}><span className={styles.typeIcon} data-kind={step.type}><Icon size={18} aria-hidden="true" /></span><div><h3>{stepNames[step.type]}</h3><p>{step.type === "ring" ? "Ľudia v tomto kroku zvonia naraz" : step.type === "wait" ? "Priestor na ručné prevzatie" : step.type === "repeat" ? "Ďalší pokus o spojenie" : "Bežný telefonický hovor"}</p></div></div>
              <div className={styles.stepTools}>
                <label className={styles.duration}><span className={styles.maximum}>{step.type === "repeat" ? "ešte" : "najviac"}</span><input type="number" min={step.type === "ring" || step.type === "external" ? 5 : 1} max={step.type === "wait" ? 60 : step.type === "repeat" ? 5 : 120} step="1" disabled={disabled} aria-label={`${step.type === "wait" ? "Minúty čakania" : step.type === "repeat" ? "Počet ďalších opakovaní" : "Sekundy zvonenia"}, krok ${index + 1}`} value={step.type === "wait" ? step.minutes : step.type === "repeat" ? step.times : step.seconds} onChange={event => updateStep(step.id, current => ({ ...current, [current.type === "wait" ? "minutes" : current.type === "repeat" ? "times" : "seconds"]: Number(event.target.value) }))} /><span>{step.type === "wait" ? "min" : step.type === "repeat" ? "×" : "s"}</span></label>
                {!disabled && <details className={styles.stepMenu} onKeyDown={event => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}><summary className={styles.iconButton} aria-label={`Možnosti kroku ${index + 1}`}><MoreHorizontal size={19} aria-hidden="true" /></summary><div className={styles.menuPanel} onClick={event => { const details = event.currentTarget.closest("details"); if (details) details.open = false; }}>
                  <button type="button" disabled={index === 0 || !moveFlowStep(flow, step.id, -1)} onClick={() => move(step.id, -1)}><ArrowUp size={15} />Posunúť vyššie</button>
                  <button type="button" disabled={index === flow.steps.length - 1 || !moveFlowStep(flow, step.id, 1)} onClick={() => move(step.id, 1)}><ArrowDown size={15} />Posunúť nižšie</button>
                  <button type="button" disabled={flow.steps.length >= MAX_INCOMING_FLOW_STEPS} onClick={() => { const steps = [...flow.steps]; steps.splice(index + 1, 0, { ...structuredClone(step), id: crypto.randomUUID() }); onChange({ ...flow, steps }); }}><Copy size={15} />Duplikovať</button>
                  <button type="button" onClick={() => setDialog({ kind: "remove", stepId: step.id })}><Trash2 size={15} />Odstrániť krok</button>
                </div></details>}
              </div>
            </div>
            {step.type === "ring" && <>
              <div className={styles.people}>{step.people.map(person => {
                const operator = document.operators.find(candidate => candidate.profileId === person.profileId);
                const name = operator?.displayName ?? "Nedostupný operátor";
                const number = person.personalNumber ?? rememberedNumbers[memoryKey(step.id, person.profileId)] ?? normalizeE164(operator?.settings?.defaultMobileNumber);
                const validNumber = Boolean(number && !personalNumberIssue(number, document, person.profileId));
                const numberId = `personal-${step.id}-${person.profileId}`;
                return <div key={person.profileId} className={styles.person}>
                  <div className={styles.personIdentity}><span className={styles.avatar} aria-hidden="true">{initial(name)}</span><div><p className={styles.personName}>{name}</p><p className={styles.personRole}>{operator && eligible(operator) ? "Operátor" : "Nie je aktívny"}</p></div></div>
                  <div className={styles.channels} role="group" aria-label={`Spôsoby zvonenia: ${name}`}>
                    <div className={styles.channel}><label className={styles.toggle}><input type="checkbox" checked={person.application} disabled={disabled} onChange={() => togglePerson(step, person, "application")} aria-label={`${name}: Aplikácia`} /><MonitorSmartphone size={14} aria-hidden="true" />Aplikácia</label><small>Web aj mobilná appka</small></div>
                    <div className={styles.channel}><label className={styles.toggle}><input type="checkbox" checked={Boolean(person.personalNumber)} disabled={disabled || !document.capabilities?.ownedMobileRouting} onChange={() => togglePerson(step, person, "personalNumber")} aria-label={`${name}: Osobné číslo`} aria-describedby={numberId} /><Phone size={14} aria-hidden="true" />Osobné číslo</label><small className={styles.numberCaption} id={numberId}>{!document.capabilities?.ownedMobileRouting ? <span>Nie je aktivované</span> : validNumber ? <span>{formatPhoneNumberForDisplay(number!)}</span> : <span className={styles.missing}><AlertTriangle size={11} aria-hidden="true" />{number ? "Číslo treba opraviť" : "Číslo chýba"}</span>}{!disabled && document.capabilities?.ownedMobileRouting && <button type="button" aria-label={`${validNumber ? "Zmeniť" : "Doplniť"} osobné číslo: ${name}`} onClick={() => setDialog({ kind: "number", stepId: step.id, profileId: person.profileId, number: number ?? "" })}>{validNumber ? "Zmeniť" : "Doplniť číslo"}</button>}</small></div>
                  </div>
                  {!disabled && <button type="button" className={styles.iconButton} aria-label={`Odstrániť ${name} z kroku ${index + 1}`} onClick={() => updateStep(step.id, current => current.type === "ring" ? { ...current, people: current.people.filter(candidate => candidate.profileId !== person.profileId) } : current)}><X size={16} aria-hidden="true" /></button>}
                </div>;
              })}</div>
              {!step.people.length && <p className={styles.stepBody}>Pridaj aspoň jedného človeka, ktorému bude hovor zvoniť.</p>}
              {!disabled && <div className={styles.stepFooter}><button type="button" className={styles.textButton} onClick={() => setDialog({ kind: "people", stepId: step.id })}><Plus size={15} aria-hidden="true" />Pridať človeka</button><small>Možno zapnúť obe možnosti naraz.</small></div>}
            </>}
            {step.type === "wait" && <div className={styles.stepBody}><p>Volajúci počuje hudbu. Operátor môže hovor prevziať z čakárne; zariadenia počas čakania nezvonia.</p><div className={styles.presets}>{[1, 5, 15].map(minutes => <button key={minutes} type="button" className={styles.preset} disabled={disabled} aria-pressed={step.minutes === minutes} onClick={() => updateStep(step.id, current => ({ ...current, minutes }))}>{minutes} min</button>)}<span>Po limite nasleduje ďalší krok.</span></div></div>}
            {step.type === "repeat" && <div className={styles.stepBody}><p>Poradie opakovania: {step.stepIds.map(id => flow.steps.findIndex(candidate => candidate.id === id) + 1).join(" → ") || "vyber kroky"}. Čakáreň sa neopakuje.</p><div className={styles.repeatChoices}>{flow.steps.slice(0, index).filter(candidate => candidate.type === "ring" || candidate.type === "external").map(candidate => <label key={candidate.id}><input type="checkbox" disabled={disabled} checked={step.stepIds.includes(candidate.id)} onChange={event => updateStep(step.id, current => current.type === "repeat" ? { ...current, stepIds: flow.steps.filter(item => event.target.checked ? item.id === candidate.id || current.stepIds.includes(item.id) : item.id !== candidate.id && current.stepIds.includes(item.id)).map(item => item.id) } : current)} /><span>Krok {flow.steps.indexOf(candidate) + 1}: {incomingStepSummary(candidate, flow, document)}</span></label>)}</div>{!flow.steps.slice(0, index).some(candidate => candidate.type === "ring" || candidate.type === "external") && <p className={styles.error}>Najprv pridaj pred opakovanie krok so zvonením.</p>}</div>}
            {step.type === "external" && <div className={styles.stepBody}><label className={styles.phoneLabel}>Telefónne číslo<input type="tel" inputMode="tel" autoComplete="off" maxLength={30} className={styles.phoneInput} disabled={disabled} aria-label={`Telefónne číslo, krok ${index + 1}`} value={step.number} placeholder="+421 910 123 456" onChange={event => updateStep(step.id, current => current.type === "external" ? { ...current, number: event.target.value } : current)} onBlur={() => { const normalized = normalizeE164(step.number); if (normalized && normalized !== step.number) updateStep(step.id, current => current.type === "external" ? { ...current, number: normalized } : current); }} /></label><p className={styles.note}>Ak nikto nezdvihne, pokračuje ďalší krok.</p></div>}
          </div>
          <div className={styles.connector}><ArrowDown size={13} aria-hidden="true" />{step.type === "wait" ? "Ak nikto neprevezme hovor včas" : step.type === "repeat" ? "Ak ani po opakovaní nikto nezdvihne" : "Ak nikto nezdvihne"}</div>
        </article>;
      })}
      <div className={styles.endCard}><MessageSquare size={18} aria-hidden="true" /><div className={styles.endCopy}><h3>{FLOW_ENDINGS[flow.ending]}</h3><p>{flow.ending === "callback_prompt" ? "Volajúci potvrdí spätné volanie tlačidlom. Bez potvrdenia sa hovor ukončí." : "Až keď sa nepodarí spojiť hovor v žiadnom kroku."}</p></div>{!disabled && <button type="button" className={styles.textButton} onClick={() => setDialog({ kind: "ending" })}>Zmeniť</button>}</div>
    </div>
    {!disabled && <div className={styles.addArea}><button type="button" disabled={flow.steps.length >= MAX_INCOMING_FLOW_STEPS} className={styles.addButton} aria-expanded={addOpen} onClick={() => setAddOpen(!addOpen)}><Plus size={16} aria-hidden="true" />{flow.steps.length >= MAX_INCOMING_FLOW_STEPS ? `Najviac ${MAX_INCOMING_FLOW_STEPS} krokov` : "Pridať ďalší krok"}</button>{addOpen && <div className={styles.addOptions}>{(["ring", "wait", "repeat", "external"] as const).map(type => { const Icon = stepIcons[type]; return <button key={type} type="button" disabled={type === "repeat" && !flow.steps.some(step => step.type === "ring" || step.type === "external")} onClick={() => add(type)}><Icon size={19} aria-hidden="true" /><strong>{stepNames[type]}</strong><small>{type === "ring" ? "Jeden človek alebo viacerí naraz" : type === "wait" ? "Čas na ručné prevzatie hovoru" : type === "repeat" ? "Znovu vybrané predchádzajúce kroky" : "Záložný kontakt s vlastným časom"}</small></button>; })}</div>}</div>}
    {!disabled && dialog?.kind === "people" && dialogStep?.type === "ring" && <FlowDialog title="Komu má hovor zvoniť?" onClose={() => setDialog(null)}><p>Človeka pridáš do tohto kroku. Spôsoby zvonenia nastavíš pri jeho mene.</p>{document.operators.filter(operator => eligible(operator) && !dialogStep.people.some(person => person.profileId === operator.profileId)).map(operator => <button key={operator.profileId} type="button" className={styles.personChoice} onClick={() => { updateStep(dialogStep.id, current => current.type === "ring" ? { ...current, people: [...current.people, { profileId: operator.profileId, application: true, personalNumber: null }] } : current); setDialog(null); }}><span className={styles.avatar}>{initial(operator.displayName)}</span><span>{operator.displayName}</span><Plus size={18} aria-hidden="true" /></button>)}{!document.operators.some(operator => eligible(operator) && !dialogStep.people.some(person => person.profileId === operator.profileId)) && <p>Všetci dostupní operátori už sú v tomto kroku.</p>}</FlowDialog>}
    {!disabled && dialog?.kind === "number" && <PersonalNumberDialog key={`${dialog.stepId}:${dialog.profileId}`} name={document.operators.find(operator => operator.profileId === dialog.profileId)?.displayName ?? "Operátor"} number={dialog.number} profileId={dialog.profileId} document={document} onClose={() => setDialog(null)} onApply={number => { rememberNumber(memoryKey(dialog.stepId, dialog.profileId), number); updatePerson(dialog.stepId, dialog.profileId, current => ({ ...current, personalNumber: number })); setDialog(null); }} />}
    {!disabled && dialog?.kind === "ending" && <FlowDialog title="Čo sa stane úplne na konci?" onClose={() => setDialog(null)} actions={<button type="button" className={styles.button} onClick={() => setDialog(null)}><Check size={15} />Hotovo</button>}><p>Až keď sa nepodarí spojiť hovor v žiadnom kroku.</p>{Object.entries(FLOW_ENDINGS).map(([value, label]) => <label key={value} className={styles.radioChoice}><input type="radio" name="flow-ending" value={value} checked={flow.ending === value} onChange={() => onChange({ ...flow, ending: value as IncomingFlow["ending"] })} /><span>{label}</span></label>)}<p className={styles.note}>Použije sa existujúca systémová hláška. Zmena sa prejaví až po uložení postupu.</p></FlowDialog>}
    {!disabled && dialog?.kind === "remove" && <FlowDialog title="Odstrániť tento krok?" onClose={() => setDialog(null)} actions={<><button type="button" className={styles.button} onClick={() => setDialog(null)}>Ponechať</button><button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => { onChange(removeFlowStep(flow, dialog.stepId)); setDialog(null); }}>Odstrániť krok</button></>}><p>{flow.steps.some(step => step.type === "repeat" && step.stepIds.includes(dialog.stepId)) ? "Krok sa odstráni aj z opakovania. Opakovanie bez zostávajúcich krokov sa odstráni tiež." : "Hovor bude pokračovať priamo ďalším krokom. Ostatné nastavenia zostanú v návrhu."}</p></FlowDialog>}
  </>;
}
