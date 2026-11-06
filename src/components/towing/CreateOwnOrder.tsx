"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Save } from "lucide-react";
import { towingCreateFieldNames, type TowingCreateInput } from "@/domain/towing/creation";
import type { TowingFields, TowingWorkspace } from "@/domain/towing/types";
import type { MobileFieldTowingOptions } from "@/lib/mobile-api";
import { towingClient, TowingRequestError } from "./client";
import { blankFields } from "./model";
import { OrderFields } from "./OrderFields";
import type { RunOperation } from "./OrderDetail";
import { Button, Notice, usePendingChanges, type PendingChangesReporter } from "./primitives";
import styles from "./towing.module.css";

type StoredDraft = { fields: TowingFields; attempt: TowingCreateInput | null };
function restoreDraft(raw: string): StoredDraft {
  if (raw.length > 240_000) throw new Error("Oversized draft");
  const saved = JSON.parse(raw) as StoredDraft;
  const validFields = (value: TowingFields | undefined) => Boolean(value && typeof value === "object" && !Array.isArray(value)
    && typeof value.pickup === "string" && typeof value.subjectDescription === "string"
    && ["tow", "repair", "transport", "storage", "relocation"].includes(value.serviceType)
    && ["vehicle", "machine", "material"].includes(value.subjectType));
  const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  if (!saved || !validFields(saved.fields) || saved.attempt !== null && (!saved.attempt
    || saved.attempt.mode !== "self" || !uuid(saved.attempt.commandId) || !uuid(saved.attempt.targetId) || !validFields(saved.attempt.fields))) {
    throw new Error("Unreadable draft");
  }
  return saved;
}
function readStoredDraft(key: string, initial: TowingFields) {
  try {
    const raw = sessionStorage.getItem(key);
    return { draft: raw === null ? { fields: initial, attempt: null } : restoreDraft(raw), ready: true, error: "" };
  } catch { return { draft: { fields: initial, attempt: null }, ready: false,
    error: "Rozpracovaný odťah sa nepodarilo obnoviť. Pôvodný pokus už mohol byť uložený na serveri; pred novým zápisom skontrolujte svoje odťahy." }; }
}
export function CreateOwnOrder({ workspace, busy, run, onBack, onPendingChangesChange }: {
  workspace: TowingWorkspace; busy: boolean; run: RunOperation; onBack: () => void; onPendingChangesChange?: PendingChangesReporter;
}) {
  const key = `pm:towing:self-create:v1:${workspace.actor.organizationId}:${workspace.actor.userId}`;
  const [initial] = useState<TowingFields>(() => ({ ...blankFields, plannedAt: new Date().toISOString() }));
  const [loaded] = useState(() => readStoredDraft(key, initial));
  const [fields, setFields] = useState(loaded.draft.attempt?.fields ?? loaded.draft.fields);
  const [attempt, setAttempt] = useState<TowingCreateInput | null>(loaded.draft.attempt);
  const [options, setOptions] = useState<MobileFieldTowingOptions | null>(null);
  const [optionsError, setOptionsError] = useState("");
  const [optionsVersion, setOptionsVersion] = useState(0);
  const [ready, setReady] = useState(loaded.ready);
  const [restoreError, setRestoreError] = useState(loaded.error);
  const [checkedOrders, setCheckedOrders] = useState(false);
  const [error, setError] = useState("");
  const targetId = useRef<string | null>(loaded.draft.attempt?.targetId ?? null);
  const frozenAttempt = useRef(Boolean(loaded.draft.attempt));
  const dirty = JSON.stringify(fields) !== JSON.stringify(initial);
  usePendingChanges(dirty || Boolean(attempt), onPendingChangesChange);
  const restore = () => {
    const next = readStoredDraft(key, initial);
    setReady(next.ready); setRestoreError(next.error); setCheckedOrders(false);
    if (next.ready) {
      frozenAttempt.current = Boolean(next.draft.attempt); targetId.current = next.draft.attempt?.targetId ?? null;
      setFields(next.draft.attempt?.fields ?? next.draft.fields); setAttempt(next.draft.attempt);
    }
  };
  const changeFields = (next: TowingFields) => {
    if (!ready || attempt) return;
    setFields(next);
    try { sessionStorage.setItem(key, JSON.stringify({ fields: next, attempt: null } satisfies StoredDraft)); }
    catch { setError("Koncept sa nepodarilo uložiť v tomto prehliadači. Nezatvárajte formulár."); }
  };
  useEffect(() => {
    const controller = new AbortController();
    void towingClient.options(controller.signal, workspace.actor.userId).then(value => {
      setOptions(value);
      setFields(previous => frozenAttempt.current ? previous : ({ ...previous,
        ...(!previous.branchId && value.branches?.length === 1 ? { branchId: value.branches[0].id } : {}),
        ...(!previous.fleetAssetId && value.fleet?.length === 1 ? { fleetAssetId: value.fleet[0].id } : {}) }));
    }).catch(cause => { if (!controller.signal.aborted) setOptionsError(cause instanceof Error ? cause.message : "Výbery sa nepodarilo načítať."); });
    return () => controller.abort();
  }, [workspace.actor.userId, optionsVersion]);
  const save = async () => {
    if (!ready || busy || frozenAttempt.current && !attempt) return;
    setError("");
    if (!attempt && (!fields.branchId || !fields.pickup.trim() || (!fields.contact?.trim() && !fields.noContactReason?.trim()))) {
      setError("Doplňte pobočku, miesto nakládky a kontakt alebo dôvod jeho absencie."); return;
    }
    targetId.current ??= crypto.randomUUID();
    const inputFields = Object.fromEntries(towingCreateFieldNames.filter(name => fields[name] !== undefined)
      .map(name => [name, fields[name]])) as unknown as TowingFields;
    if (inputFields.realizedItems) inputFields.realizedItems = inputFields.realizedItems.map(item => ({ id: item.id, kind: item.kind,
      description: item.description, quantity: item.quantity, unit: item.unit,
      ...(item.parkingId ? { parkingId: item.parkingId } : {}), ...(item.destination ? { destination: item.destination } : {}) }));
    const input = attempt ?? { commandId: crypto.randomUUID(), targetId: targetId.current, mode: "self" as const, fields: inputFields };
    try { sessionStorage.setItem(key, JSON.stringify({ fields, attempt: input } satisfies StoredDraft)); }
    catch { setError("Pokus sa nepodarilo bezpečne uložiť. Odťah sa neodoslal."); return; }
    frozenAttempt.current = true; setAttempt(input);
    const saved = await run(`self-create:${input.targetId}`, async () => {
      try { return await towingClient.create(input, workspace.actor.userId); }
      catch (cause) {
        if (cause instanceof TowingRequestError && cause.status >= 400 && cause.status < 500) {
          frozenAttempt.current = false; setAttempt(null);
          try { sessionStorage.setItem(key, JSON.stringify({ fields, attempt: null } satisfies StoredDraft)); } catch { /* Current form is retained. */ }
        }
        throw cause;
      }
    }, "Odťah je vytvorený a pridelený vám.");
    if (saved) {
      try { sessionStorage.removeItem(key); } catch { /* The server acknowledgment remains authoritative. */ }
      onPendingChangesChange?.(false); onBack();
    }
  };
  const formWorkspace: TowingWorkspace = { ...workspace, branches: options?.branches ?? [], fleet: options?.fleet ?? [], partners: options?.partners ?? [],
    parking: options?.parking.map(site => ({ ...site, active: true, revision: 1 })) ?? [] };
  return <>
    <Button disabled={busy || Boolean(attempt)} onClick={() => {
      if (!ready || restoreError) { onBack(); return; }
      if (!dirty || window.confirm("Zahodiť rozpracovaný odťah?")) {
      try { sessionStorage.removeItem(key); } catch { /* Leaving an unsent local draft does not create a server record. */ }
      onBack();
    } }}><ArrowLeft size={16} /> Späť</Button>
    <h1 className={styles.title}>Nový odťah</h1>
    <p className={styles.subtitle}>Vodič: {workspace.actor.displayName}. Po uložení nájdete odťah vo vlastnom zozname.</p>
    {error && <Notice kind="error">{error}</Notice>}
    {optionsError && <Notice kind="error">{optionsError}<div className={styles.actions}><Button onClick={() => { setOptionsError(""); setOptionsVersion(current => current + 1); }}>Obnoviť výbery</Button></div></Notice>}
    {restoreError && <Notice kind="error">{restoreError}
      <div className={styles.actions}><Button onClick={restore}>Znova načítať pôvodný koncept</Button><Button onClick={onBack}>Skontrolovať moje odťahy</Button></div>
      <label className={styles.check}><input type="checkbox" checked={checkedOrders} onChange={event => setCheckedOrders(event.target.checked)} /> Skontroloval(a) som svoje odťahy a pôvodná zákazka neexistuje.</label>
      <Button disabled={!checkedOrders} onClick={() => {
        try { sessionStorage.removeItem(key); frozenAttempt.current = false; setFields(initial); setAttempt(null); targetId.current = null; setRestoreError(""); setReady(true); }
        catch { setRestoreError("Koncept sa nepodarilo odstrániť. Znova načítajte pôvodný záznam pred ďalším pokusom."); }
      }}>Po kontrole začať nový koncept</Button>
    </Notice>}
    {attempt && <Notice>Overte pôvodné vytvorenie. Údaje odoslaného pokusu zostávajú zachované, aby nevznikol druhý odťah.</Notice>}
    {!options && !optionsError && <p role="status">Načítavam pobočky, techniku a objednávateľov…</p>}
    <fieldset disabled={busy || Boolean(attempt) || !ready} style={{ border: 0, padding: 0, margin: 0 }}>
      <OrderFields fields={fields} onChange={changeFields} workspace={formWorkspace} driver fullOperational />
    </fieldset>
    <div className={styles.actions}><Button primary disabled={busy || !ready || !options} onClick={() => { void save(); }}>
      <Save size={17} /> {busy ? "Overujem uloženie…" : attempt ? "Overiť rovnaký odťah" : "Vytvoriť odťah pre seba"}
    </Button></div>
  </>;
}
