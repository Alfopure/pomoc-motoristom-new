"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Archive, ArrowUpRight, BookUser, Building2, CarFront, Check, ChevronRight, Edit3, Globe2, Link2, Loader2, Mail, MapPin, Phone, Plus, RotateCcw, Save, Search, UserRound, X } from "lucide-react";
import { CONTACT_ROLES, DIRECTORY_FOCUS, DIRECTORY_KINDS, DIRECTORY_LABELS, directoryDraft, directoryKey, directoryRelations, emptyDirectoryDraft, normalizeDirectorySearch, safeDirectoryWebsite, type DirectoryDraft, type DirectoryEntry, type DirectoryKind } from "@/lib/directory";
import { requestCallbackTargetConfirmation } from "@/lib/telephony/callback-target-client";
import { isDialablePhoneInput } from "@/lib/telephony/phone";
import { CallbackPolicyPanel } from "./CallbackPolicyPanel";
import { GooglePlaceAutocomplete } from "../GooglePlaceAutocomplete";
import { useReplacementVehicleAvailability } from "../useReplacementVehicleAvailability";

export type DirectoryEditor = { mode: "create"; kind: DirectoryKind; owner?: DirectoryEntry } | { mode: "view" | "edit"; entry: DirectoryEntry };
type Props = {
  editor: DirectoryEditor;
  entries: DirectoryEntry[];
  canEdit: boolean;
  onClose: () => void;
  onEdit: (entry: DirectoryEntry) => void;
  onOpen: (entry: DirectoryEntry) => void;
  onNewContact: (owner: DirectoryEntry) => void;
  onSave: (draft: DirectoryDraft, previous?: DirectoryEntry) => Promise<void>;
  onDial?: (phone: string) => Promise<void>;
};
const inputClass = "min-h-11 w-full min-w-0 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-base text-zinc-900 outline-none transition placeholder:text-zinc-400 focus:border-yellow-400 focus:ring-2 focus:ring-yellow-100 disabled:bg-zinc-50 disabled:text-zinc-500 sm:text-sm";

export function DirectoryEntryDialog({ editor, entries, canEdit, onClose, onEdit, onOpen, onNewContact, onSave, onDial }: Props) {
  const entry = editor.mode === "create" ? undefined : editor.entry;
  const viewing = editor.mode === "view";
  const [initial] = useState<DirectoryDraft>(() => entry ? directoryDraft(entry) : { ...emptyDirectoryDraft(editor.mode === "create" ? editor.kind : "company"), ...(editor.mode === "create" && editor.owner ? { role: editor.owner.kind === "branch" ? "branch" as const : editor.owner.kind === "assistance" ? "assistance" as const : "partner" as const } : {}) });
  const [draft, setDraft] = useState<DirectoryDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const formId = useId();
  const dirty = !viewing && JSON.stringify(draft) !== JSON.stringify(initial);
  const title = viewing ? entry!.name : editor.mode === "create" ? "Nový záznam" : `Upraviť: ${entry!.name}`;

  useEffect(() => {
    const node = dialog.current;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    node?.showModal();
    return () => { node?.close(); document.body.style.overflow = overflow; if (focused?.isConnected) focused.focus(); };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function close() { if (!busy) { if (dirty) setDiscard(true); else onClose(); } }
  async function submit(next = draft) {
    if (busy) return;
    setBusy(true); setError(null);
    try { await onSave(next, entry); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Záznam sa nepodarilo uložiť."); }
    finally { setBusy(false); }
  }

  return (
    <dialog ref={dialog} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }} className="fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-dvh w-full max-w-[640px] border-0 bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-zinc-950/35">
      <div className="flex h-full min-h-0 flex-col" onClick={event => event.stopPropagation()}>
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-zinc-200 px-5 py-5 sm:px-7">
          <div className="min-w-0"><div className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-500"><BookUser size={14} />Adresár<span>/</span>{DIRECTORY_LABELS[draft.kind]}</div><h2 id={titleId} className="break-words text-xl font-bold tracking-tight">{title}</h2>{editor.mode === "create" && editor.owner && <p className="mt-1 text-sm text-zinc-500">Kontaktná osoba pre {editor.owner.name}</p>}</div>
          <button type="button" onClick={close} disabled={busy} aria-label="Zavrieť detail adresára" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500 hover:bg-zinc-200 disabled:opacity-50"><X size={20} /></button>
        </header>
        {discard && <div role="alert" className="shrink-0 border-b border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p className="font-semibold">Máte neuložené zmeny.</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={() => setDiscard(false)} className="min-h-10 rounded-lg border border-amber-300 bg-white px-3 font-medium">Pokračovať v úprave</button><button type="button" onClick={onClose} className="min-h-10 rounded-lg px-3 font-medium underline">Zahodiť zmeny</button></div></div>}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 sm:p-7">
          {viewing && entry ? <EntryDetails entry={entry} entries={entries} canEdit={canEdit} onOpen={onOpen} onEdit={onEdit} onNewContact={onNewContact} onDial={onDial ? async phone => { await onDial(phone); onClose(); } : undefined} /> : <form id={formId} onSubmit={event => { event.preventDefault(); void submit(); }}>
            <fieldset disabled={busy} className="min-w-0 space-y-6">
              {editor.mode === "create" && !editor.owner && <div><p className="mb-2 text-xs font-semibold text-zinc-500">Čo chcete pridať?</p><div className="grid grid-cols-2 gap-2">{DIRECTORY_KINDS.map(kind => <button type="button" key={kind} aria-pressed={draft.kind === kind} onClick={() => { setDraft({ ...emptyDirectoryDraft(kind), name: draft.name, phone: draft.phone, email: draft.email, note: draft.note }); setError(null); }} className={`min-h-11 rounded-lg border px-3 py-2 text-sm font-medium ${draft.kind === kind ? "border-yellow-400 bg-yellow-50 text-zinc-950 ring-1 ring-yellow-400" : "border-zinc-200 text-zinc-500 hover:bg-zinc-50"}`}>{DIRECTORY_LABELS[kind]}</button>)}</div></div>}
              <div className="space-y-4">
                <TextField label={draft.kind === "contact" ? "Meno a priezvisko" : "Názov"} value={draft.name} onChange={name => setDraft({ ...draft, name })} required maxLength={180} placeholder={draft.kind === "contact" ? "Napr. Ján Novák" : draft.kind === "branch" ? "Napr. Pobočka Žilina" : "Názov spoločnosti"} />
                <div className="grid gap-4 sm:grid-cols-2"><TextField label="Telefón" type="tel" value={draft.phone} onChange={phone => setDraft({ ...draft, phone })} maxLength={40} placeholder="+421 …" /><TextField label="E-mail" type="email" value={draft.email} onChange={email => setDraft({ ...draft, email })} maxLength={254} placeholder="kontakt@firma.sk" /></div>
                {draft.kind === "contact" ? <><p className="text-xs text-zinc-500">Doplňte aspoň telefón alebo e-mail. Telefón sa používa aj v zozname kontaktov pri volaní.</p><SelectField label="Zaradenie osoby" value={draft.role} onChange={role => setDraft({ ...draft, role: role as DirectoryDraft["role"] })} options={Object.entries(CONTACT_ROLES)} /></> : <>
                  {(draft.kind === "company" || draft.kind === "assistance") && <div className="grid gap-4 sm:grid-cols-2"><TextField label="IČO" value={draft.ico} onChange={ico => setDraft({ ...draft, ico })} maxLength={32} /><SelectField label="Zameranie" value={draft.focus} onChange={focus => setDraft({ ...draft, focus: focus as DirectoryDraft["focus"] })} options={Object.entries(DIRECTORY_FOCUS)} /></div>}
                  {draft.kind === "branch" ? <BranchFields draft={draft} setDraft={setDraft} entries={entries} /> : <TextField label="Adresa" value={draft.address} onChange={address => setDraft({ ...draft, address })} maxLength={500} placeholder="Ulica, mesto, PSČ" />}
                  <TextField label="Web" value={draft.website} onChange={website => setDraft({ ...draft, website })} maxLength={500} placeholder="www.firma.sk" />
                </>}
              </div>
              {draft.kind !== "contact" && <ContactPicker entries={entries} value={draft.contactIds} onChange={contactIds => setDraft({ ...draft, contactIds })} />}
              <label className="block"><span className="mb-1.5 block text-sm font-medium text-zinc-700">Interná poznámka</span><textarea value={draft.note} onChange={event => setDraft({ ...draft, note: event.target.value })} rows={4} maxLength={4000} placeholder="Dostupnosť, kontaktná osoba, pokyny pre dispečera…" className={`${inputClass} resize-y`} /></label>
            </fieldset>
          </form>}
        </div>
        <footer className="shrink-0 border-t border-zinc-200 bg-zinc-50 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-7">
          {error && <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
          {archiveConfirm && entry && <div role="alert" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p>Archivovať {entry.name}? Záznam ostane v histórii a môžete ho neskôr obnoviť.</p><div className="mt-2 flex gap-2"><button type="button" disabled={busy} onClick={() => void submit({ ...directoryDraft(entry), active: false })} className="min-h-10 rounded-lg bg-zinc-900 px-3 font-semibold text-white">{busy ? "Archivujem…" : "Archivovať"}</button><button type="button" disabled={busy} onClick={() => setArchiveConfirm(false)} className="min-h-10 px-3 font-medium">Ponechať aktívny</button></div></div>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {viewing && entry ? <><div>{canEdit && (entry.kind === "company" || entry.kind === "assistance") && <button type="button" disabled={busy} onClick={() => entry.active ? setArchiveConfirm(true) : void submit({ ...directoryDraft(entry), active: true })} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-medium text-zinc-500 hover:bg-zinc-200 disabled:opacity-50">{entry.active ? <Archive size={16} /> : <RotateCcw size={16} />}{entry.active ? "Do archívu" : "Obnoviť z archívu"}</button>}</div>{canEdit ? <button type="button" disabled={busy} onClick={() => onEdit(entry)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#FCD703] px-5 text-sm font-semibold text-zinc-950 hover:bg-yellow-400 disabled:opacity-50"><Edit3 size={16} />Upraviť záznam</button> : <button type="button" onClick={close} className="min-h-11 rounded-lg border border-zinc-200 bg-white px-5 text-sm font-semibold">Zavrieť</button>}</> : <><button type="button" disabled={busy} onClick={close} className="min-h-11 rounded-lg border border-zinc-200 bg-white px-4 text-sm font-semibold text-zinc-700">Zrušiť</button><button type="submit" form={formId} disabled={busy || !draft.name.trim() || (draft.kind === "contact" && !draft.phone.trim() && !draft.email.trim()) || (draft.kind === "branch" && !entry && !draft.location)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#FCD703] px-5 text-sm font-semibold text-zinc-950 hover:bg-yellow-400 disabled:bg-zinc-200 disabled:text-zinc-500">{busy ? <Loader2 size={17} className="animate-spin" /> : <Save size={17} />}{busy ? "Ukladám…" : "Uložiť záznam"}</button></>}
          </div>
        </footer>
      </div>
    </dialog>
  );
}

function EntryDetails({ entry, entries, canEdit, onOpen, onEdit, onNewContact, onDial }: Pick<Props, "entries" | "canEdit" | "onOpen" | "onEdit" | "onNewContact" | "onDial"> & { entry: DirectoryEntry }) {
  const [dialing, setDialing] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const website = safeDirectoryWebsite(entry.website);
  const relations = directoryRelations(entry, entries);
  const people = entries.filter(item => item.kind === "contact" && entry.contactIds.includes(item.id));
  async function call() {
    if (dialing) return;
    setDialing(true); setCallError(null);
    try {
      if (onDial) await onDial(entry.phone);
      else {
        const target = await requestCallbackTargetConfirmation(entry.phone);
        if (target) window.location.assign(`tel:${target.dialNumber.replace(/[^+\d]/g, "")}`);
      }
    } catch (caught) { setCallError(caught instanceof Error ? caught.message : "Hovor sa nepodarilo spustiť."); }
    finally { setDialing(false); }
  }
  return <div className="space-y-7">
    <div className="flex flex-wrap items-center gap-2"><span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${entry.active ? "bg-emerald-50 text-emerald-700" : "bg-zinc-100 text-zinc-500"}`}>{entry.active ? <Check size={12} /> : <Archive size={12} />}{entry.active ? "Aktívny záznam" : "V archíve"}</span>{entry.focus && <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-600">{DIRECTORY_FOCUS[entry.focus]}</span>}{entry.kind === "contact" && <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-600">{CONTACT_ROLES[entry.role]}</span>}</div>
    <div className="space-y-3">
      <DetailLine icon={<Phone size={18} />} label="Telefón">{entry.phone ? <div className="flex flex-wrap items-center gap-3"><span className="break-all font-medium text-zinc-900">{entry.phone}</span>{isDialablePhoneInput(entry.phone) && <button type="button" onClick={() => void call()} disabled={dialing} className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-zinc-900 px-3 text-xs font-semibold text-white disabled:opacity-50">{dialing ? <Loader2 size={13} className="animate-spin" /> : <Phone size={13} />}Zavolať</button>}</div> : <span className="text-zinc-400">Nie je doplnený</span>}</DetailLine>
      <DetailLine icon={<Mail size={18} />} label="E-mail">{entry.email ? <a href={`mailto:${encodeURIComponent(entry.email)}`} className="break-all text-zinc-900 underline decoration-zinc-300 underline-offset-4">{entry.email}</a> : <span className="text-zinc-400">Nie je doplnený</span>}</DetailLine>
      {entry.address && <DetailLine icon={<MapPin size={18} />} label="Adresa"><span className="block break-words">{entry.address}</span><a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(entry.location ? `${entry.location.lat},${entry.location.lng}` : entry.address)}`} target="_blank" rel="noreferrer" className="mt-1 inline-flex min-h-8 items-center gap-1 text-xs font-medium text-zinc-500 underline underline-offset-4">Zobraziť na mape<ArrowUpRight size={12} /></a></DetailLine>}
      {entry.ico && <DetailLine icon={<Building2 size={18} />} label="IČO">{entry.ico}</DetailLine>}
      {website && <DetailLine icon={<Globe2 size={18} />} label="Web"><a href={website} target="_blank" rel="noreferrer" className="break-all underline decoration-zinc-300 underline-offset-4">{entry.website}<ArrowUpRight size={12} className="ml-1 inline" /></a></DetailLine>}
      {callError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{callError}</p>}
    </div>
    {entry.kind === "contact" && <CallbackPolicyPanel entry={entry} entries={entries} canEdit={canEdit} />}
    {entry.kind === "branch" && <BranchCapacity entry={entry} />}
    {relations.length > 0 && <section><h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-900"><Link2 size={16} />{entry.kind === "contact" ? "Priradené firmy a pobočky" : entry.kind === "branch" ? "Patrí k spoločnosti" : "Pobočky"}</h3><div className="space-y-2">{relations.map(item => <RelatedEntry key={directoryKey(item)} entry={item} onOpen={onOpen} />)}</div></section>}
    {entry.kind !== "contact" && <section className="border-t border-zinc-200 pt-5"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-900"><UserRound size={16} />Kontaktné osoby <span className="text-zinc-400">{people.length}</span></h3>{canEdit && <button type="button" onClick={() => onNewContact(entry)} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 text-xs font-semibold"><Plus size={14} />Nová osoba</button>}</div><div className="space-y-2">{people.map(person => <RelatedEntry key={person.id} entry={person} onOpen={onOpen} />)}{people.length === 0 && <p className="rounded-lg bg-zinc-50 p-4 text-sm text-zinc-500">Zatiaľ nie je priradená žiadna kontaktná osoba.</p>}</div>{canEdit && <button type="button" onClick={() => onEdit(entry)} className="mt-2 inline-flex min-h-9 items-center gap-1.5 text-xs font-semibold text-zinc-600 underline underline-offset-4"><Link2 size={13} />Priradiť existujúcu osobu</button>}</section>}
    {entry.note && <section className="border-t border-zinc-200 pt-5"><h3 className="mb-2 text-sm font-semibold">Interná poznámka</h3><p className="whitespace-pre-wrap break-words rounded-lg bg-amber-50/60 p-4 text-sm leading-relaxed text-zinc-700">{entry.note}</p></section>}
    <p className="border-t border-zinc-100 pt-4 text-xs text-zinc-400">Naposledy upravené {new Date(entry.updatedAt).toLocaleString("sk-SK", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Bratislava" })}</p>
  </div>;
}

function BranchCapacity({ entry }: { entry: DirectoryEntry }) {
  const availability = useReplacementVehicleAvailability();
  const live = availability.source === "swhouse" ? availability.byBranch[entry.id] : undefined;
  return <div className="flex items-center gap-3 rounded-xl border border-emerald-100 bg-emerald-50/60 p-4"><CarFront size={25} className="text-emerald-700" /><div><p className="text-lg font-bold text-zinc-900">{live ?? entry.availableReplacementCars} <span className="text-sm font-medium">náhradných vozidiel</span></p><p className="mt-0.5 text-xs text-zinc-500">{live !== undefined ? "Aktuálna dostupnosť zo systému vozidiel" : "Ručne nastavená dostupnosť"}</p></div></div>;
}

function BranchFields({ draft, setDraft, entries }: { draft: DirectoryDraft; setDraft: (draft: DirectoryDraft) => void; entries: DirectoryEntry[] }) {
  const [manual, setManual] = useState(false);
  const [coordinates, setCoordinates] = useState({ lat: draft.location ? String(draft.location.lat) : "", lng: draft.location ? String(draft.location.lng) : "" });
  function setManualPlace(address: string, next = coordinates) {
    setCoordinates(next);
    const lat = Number(next.lat), lng = Number(next.lng);
    const valid = address.trim().length >= 3 && next.lat.trim() && next.lng.trim() && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    setDraft({ ...draft, address, location: valid ? { address, label: draft.name, lat, lng, provider: "manual" } : null });
  }
  return <div className="space-y-4">
    <SelectField label="Firma / asistenčná spoločnosť" value={draft.parentId ?? ""} onChange={parentId => setDraft({ ...draft, parentId: parentId || null })} options={[["", "Samostatná pobočka"], ...entries.filter(entry => entry.kind === "company" || entry.kind === "assistance").sort((a, b) => a.name.localeCompare(b.name, "sk")).map(entry => [entry.id, `${entry.name}${entry.active ? "" : " (v archíve)"}`])]} />
    {!manual ? <><GooglePlaceAutocomplete label="Adresa pobočky" value={draft.location} onSelect={location => { setDraft({ ...draft, location, address: location.address }); setCoordinates({ lat: String(location.lat), lng: String(location.lng) }); }} />{draft.address && <p className="text-xs text-zinc-500">Uložená adresa: {draft.address}</p>}<button type="button" onClick={() => setManual(true)} className="min-h-9 text-xs font-medium text-zinc-600 underline underline-offset-4">Zadať adresu a polohu ručne</button></> : <div className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3"><TextField label="Adresa pobočky" value={draft.address} onChange={address => setManualPlace(address)} required maxLength={500} /><div className="grid grid-cols-2 gap-3"><TextField label="Zemepisná šírka" type="number" step="any" value={coordinates.lat} onChange={lat => setManualPlace(draft.address, { ...coordinates, lat })} required /><TextField label="Zemepisná dĺžka" type="number" step="any" value={coordinates.lng} onChange={lng => setManualPlace(draft.address, { ...coordinates, lng })} required /></div><p className="text-xs leading-relaxed text-zinc-500">Súradnice určujú polohu pobočky na dispečerskej mape.</p></div>}
    <TextField label="Ručná dostupnosť náhradných vozidiel" type="number" min={0} step={1} value={String(draft.availableReplacementCars)} onChange={value => setDraft({ ...draft, availableReplacementCars: Number(value) })} required /><p className="text-xs text-zinc-500">Použije sa, keď nie je dostupný aktuálny počet zo systému vozidiel.</p>
  </div>;
}

function ContactPicker({ entries, value, onChange }: { entries: DirectoryEntry[]; value: string[]; onChange: (ids: string[]) => void }) {
  const [query, setQuery] = useState("");
  const contacts = entries.filter(entry => entry.kind === "contact");
  const matching = contacts.filter(entry => normalizeDirectorySearch(`${entry.name} ${entry.phone} ${entry.email}`).includes(normalizeDirectorySearch(query)));
  return <section className="border-t border-zinc-200 pt-5"><h3 className="mb-1 text-sm font-semibold">Kontaktné osoby</h3><p className="mb-3 text-xs leading-relaxed text-zinc-500">Priraďte osoby z adresára. Novú osobu môžete pridať aj priamo z detailu uloženého záznamu.</p>
    {value.length > 0 && <div className="mb-3 flex flex-wrap gap-2">{value.map(id => <span key={id} className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-yellow-50 py-1 pl-2.5 pr-1 text-xs font-medium text-zinc-700"><span className="truncate">{contacts.find(contact => contact.id === id)?.name ?? "Nedostupný kontakt"}</span><button type="button" aria-label={`Odobrať osobu ${contacts.find(contact => contact.id === id)?.name ?? id}`} onClick={() => onChange(value.filter(item => item !== id))} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-yellow-100"><X size={13} /></button></span>)}</div>}
    <label className="mb-2 flex min-h-11 items-center gap-2 rounded-lg border border-zinc-200 px-3"><Search size={15} className="text-zinc-400" /><input aria-label="Hľadať kontaktné osoby" value={query} onChange={event => setQuery(event.target.value)} placeholder="Vyhľadať meno alebo telefón" className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none" /></label>
    <div className="max-h-48 overflow-y-auto rounded-lg border border-zinc-200">{matching.slice(0, 30).map(contact => <label key={contact.id} className="flex min-h-12 cursor-pointer items-center gap-3 border-b border-zinc-100 px-3 py-2 last:border-0 hover:bg-zinc-50"><input type="checkbox" checked={value.includes(contact.id)} onChange={event => onChange(event.target.checked ? [...value, contact.id] : value.filter(id => id !== contact.id))} className="h-4 w-4 shrink-0 accent-zinc-900" /><span className="min-w-0"><span className="block truncate text-sm font-medium">{contact.name}</span><span className="block truncate text-xs text-zinc-500">{contact.phone || contact.email}</span></span></label>)}{matching.length === 0 && <p className="p-3 text-sm text-zinc-500">{contacts.length ? "Žiadna osoba nezodpovedá hľadaniu." : "V adresári zatiaľ nie sú kontaktné osoby."}</p>}</div>{matching.length > 30 && <p className="mt-2 text-xs text-zinc-500">Zobrazených je prvých 30 osôb. Spresnite hľadanie.</p>}
  </section>;
}

function RelatedEntry({ entry, onOpen }: { entry: DirectoryEntry; onOpen: (entry: DirectoryEntry) => void }) {
  return <button type="button" onClick={() => onOpen(entry)} className="flex min-h-14 w-full min-w-0 items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2 text-left hover:bg-zinc-50"><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{entry.name}{!entry.active && <span className="ml-2 text-xs font-normal text-zinc-400">V archíve</span>}</span><span className="block truncate text-xs text-zinc-500">{entry.phone || entry.email || DIRECTORY_LABELS[entry.kind]}</span></span><ChevronRight size={15} className="shrink-0 text-zinc-400" /></button>;
}

function DetailLine({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return <div className="flex min-w-0 items-start gap-3 rounded-lg border border-zinc-100 p-3"><span className="mt-0.5 shrink-0 text-zinc-400">{icon}</span><div className="min-w-0 flex-1"><p className="mb-1 text-xs text-zinc-400">{label}</p><div className="text-sm text-zinc-800">{children}</div></div></div>;
}
function TextField({ label, value, onChange, type = "text", ...props }: { label: string; value: string; onChange: (value: string) => void; type?: string; required?: boolean; maxLength?: number; placeholder?: string; min?: number; step?: string | number }) {
  return <label className="block min-w-0"><span className="mb-1.5 block text-sm font-medium text-zinc-700">{label}{props.required && <span className="ml-1 text-amber-600" aria-hidden="true">*</span>}</span><input type={type} value={value} onChange={event => onChange(event.target.value)} className={inputClass} {...props} /></label>;
}
function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[][] }) {
  return <label className="block min-w-0"><span className="mb-1.5 block text-sm font-medium text-zinc-700">{label}</span><select value={value} onChange={event => onChange(event.target.value)} className={inputClass}>{options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>;
}
