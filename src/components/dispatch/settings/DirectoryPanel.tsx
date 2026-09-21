"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowRight, BookUser, Building2, Check, ChevronLeft, ChevronRight, FolderDown, Loader2, MapPin, Plus, Search, ShieldCheck, UserRound, X } from "lucide-react";
import type { DispatchData } from "@/data/dispatch-types";
import { DIRECTORY_FILTERS, DIRECTORY_KINDS, DIRECTORY_LABELS, directoryDraft, directoryKey, directoryRelations, filterDirectory, type DirectoryData, type DirectoryDraft, type DirectoryEntry, type DirectoryKind } from "@/lib/directory";
import { DirectoryEntryDialog, type DirectoryEditor } from "./DirectoryEntryDialog";
import { DirectoryRequestError, loadDirectory, saveDirectory } from "./directory-client";

export const DIRECTORY_ICONS = { company: Building2, assistance: ShieldCheck, branch: MapPin, contact: UserRound };
const PAGE_SIZE = 25;
const DIRECTORY_REFRESH_MS = 60_000;

export function DirectoryPanel({ onDataChange, onDial }: { onDataChange: (data: DispatchData) => void; onDial?: (phone: string) => Promise<void> }) {
  const [data, setData] = useState<DirectoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<DirectoryKind | "all">("all");
  const [status, setStatus] = useState<"active" | "archived" | "all">("active");
  const [page, setPage] = useState(0);
  const [editor, setEditor] = useState<DirectoryEditor | null>(null);
  const [importing, setImporting] = useState(false);
  const [accessHidden, setAccessHidden] = useState(false);
  const [editorPaused, setEditorPaused] = useState(false);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const denied = useRef(false);
  const hasVerifiedData = useRef(false);
  const mutation = useRef(false);
  const readController = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const failures = useRef(0);
  const refreshAfterMutation = useRef(false);
  const reloadRef = useRef<() => Promise<void>>(async () => {});
  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    if (!mounted.current || mutation.current || document.visibilityState !== "visible") return;
    timer.current = setTimeout(() => void reloadRef.current(), DIRECTORY_REFRESH_MS * Math.min(4, 2 ** failures.current));
  }, []);
  const cancelRead = useCallback(() => {
    sequence.current += 1;
    readController.current?.abort(); readController.current = null;
    clearTimeout(timer.current); clearTimeout(resumeTimer.current); resumeTimer.current = undefined;
    if (mounted.current) setLoading(false);
  }, []);
  const hideAccess = useCallback(() => {
    denied.current = true; setAccessHidden(true); setEditorPaused(true); setNotice(null);
    setError("Prístup k adresáru nie je dostupný. Údaje sú dočasne skryté.");
  }, []);
  const reload = useCallback(async () => {
    if (!mounted.current || document.visibilityState !== "visible") return;
    if (mutation.current) { refreshAfterMutation.current = true; return; }
    if (readController.current) return;
    clearTimeout(timer.current); clearTimeout(resumeTimer.current); resumeTimer.current = undefined;
    const controller = new AbortController(); readController.current = controller;
    const current = ++sequence.current;
    setLoading(true);
    try {
      const next = await loadDirectory(AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
      if (!mounted.current || current !== sequence.current || controller.signal.aborted) return;
      hasVerifiedData.current = true;
      setData(next);
      // A viewed entry follows the authorised snapshot; an edit/create owns its draft.
      setEditor(open => {
        if (!open || open.mode !== "view") return open;
        const entry = next.entries.find(item => directoryKey(item) === directoryKey(open.entry));
        return entry ? { mode: "view", entry } : null;
      });
      failures.current = 0; denied.current = false; setAccessHidden(false); setError(null);
    } catch (caught) {
      if (!mounted.current || current !== sequence.current || controller.signal.aborted) return;
      failures.current += 1;
      if (caught instanceof DirectoryRequestError && [401, 403].includes(caught.status)) hideAccess();
      else if (!denied.current) setError(hasVerifiedData.current ? "Zmeny adresára sa nepodarilo overiť. Zobrazujú sa posledné načítané údaje." : "Adresár sa nepodarilo načítať. Skúste to znova.");
    } finally {
      if (readController.current === controller) {
        readController.current = null;
        if (mounted.current) { setLoading(false); schedule(); }
      }
    }
  }, [hideAccess, schedule]);
  useEffect(() => {
    mounted.current = true; reloadRef.current = reload;
    timer.current = setTimeout(() => void reload(), 0);
    const resume = () => {
      if (document.visibilityState !== "visible") { cancelRead(); return; }
      if (resumeTimer.current || readController.current) return;
      // Focus, online and visibility often arrive together. One local read is enough.
      resumeTimer.current = setTimeout(() => { resumeTimer.current = undefined; void reload(); }, 100);
    };
    window.addEventListener("focus", resume); window.addEventListener("online", resume); document.addEventListener("visibilitychange", resume);
    return () => {
      mounted.current = false; cancelRead();
      window.removeEventListener("focus", resume); window.removeEventListener("online", resume); document.removeEventListener("visibilitychange", resume);
    };
  }, [cancelRead, reload]);

  function beginMutation() {
    if (denied.current || !data?.canEdit) throw new DirectoryRequestError("Nemáte oprávnenie upravovať adresár.", 403);
    if (mutation.current) throw new Error("Počkajte na dokončenie predchádzajúcej zmeny.");
    mutation.current = true; cancelRead();
  }
  function finishMutation() {
    mutation.current = false;
    if (refreshAfterMutation.current) { refreshAfterMutation.current = false; void reload(); }
    else schedule();
  }
  function openEditor(next: DirectoryEditor) {
    if (editor && editorPaused) return;
    setEditorPaused(false); setEditor(next);
  }

  const entries = data?.entries ?? [];
  const visible = useMemo(() => filterDirectory(data?.entries ?? [], { query, kind, status }), [data, query, kind, status]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1));
  const counts = useMemo(() => {
    const active = (data?.entries ?? []).filter(entry => status === "all" || entry.active === (status === "active"));
    return { all: active.length, ...Object.fromEntries(DIRECTORY_KINDS.map(type => [type, active.filter(entry => entry.kind === type).length])) } as Record<DirectoryKind | "all", number>;
  }, [data, status]);

  async function save(draft: DirectoryDraft, previous?: DirectoryEntry) {
    beginMutation();
    try {
      const result = await saveDirectory(draft, previous);
      if (!mounted.current) return;
      // Invalidate an older list request before applying the confirmed write.
      sequence.current += 1; setLoading(false);
      setData(current => current ? { ...current, entries: [...current.entries.filter(entry => directoryKey(entry) !== directoryKey(result.entry)), result.entry] } : current);
      if (result.dispatchData) onDataChange(result.dispatchData);
      if (!previous && draft.kind === "contact" && editor?.mode === "create" && editor.owner) {
        const owner = editor.owner;
        try {
          const linked = await saveDirectory({ ...directoryDraft(owner), contactIds: [...new Set([...owner.contactIds, result.entry.id])] }, owner);
          setData(current => current ? { ...current, entries: current.entries.map(item => directoryKey(item) === directoryKey(linked.entry) ? linked.entry : item) } : current);
          if (linked.dispatchData) onDataChange(linked.dispatchData);
          setNotice(`${result.entry.name}: kontakt je uložený a priradený k ${owner.name}.`);
          setEditor({ mode: "view", entry: linked.entry });
        } catch (caught) {
          if (caught instanceof DirectoryRequestError && [401, 403].includes(caught.status)) hideAccess();
          // Contact creation committed. Never report it as failed or invite another POST.
          setNotice(`${result.entry.name}: kontakt je uložený. Priradenie k ${owner.name} sa nepodarilo; otvorte firmu alebo pobočku a priraďte existujúcu osobu.`);
          setEditor({ mode: "view", entry: result.entry });
          void reload();
        }
        return;
      }
      setNotice(result.refreshRequired ? "Záznam je uložený. Na obnovenie mapy a prípadov obnovte aplikáciu." : `${result.entry.name}: zmeny sú uložené.`);
      setEditor({ mode: "view", entry: result.entry });
    } catch (caught) {
      if (caught instanceof DirectoryRequestError && [401, 403].includes(caught.status)) hideAccess();
      if (caught instanceof DirectoryRequestError && caught.status === 409) void reload();
      throw caught;
    } finally { finishMutation(); }
  }

  async function importAssistance() {
    if (importing || denied.current || !data?.canEdit || mutation.current) return;
    beginMutation();
    setImporting(true); setNotice(null); setError(null);
    try {
      const response = await fetch("/api/partner-directory/backfill-assistance", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new DirectoryRequestError(result.error ?? "Asistenčné spoločnosti sa nepodarilo prevziať.", response.status);
      if (result.dispatchData) onDataChange(result.dispatchData);
      await reload();
      setNotice(result.created?.length ? `Do adresára pribudlo ${result.created.length} asistenčných spoločností.` : "Všetky asistenčné spoločnosti z prípadov už v adresári sú.");
    } catch (caught) {
      if (caught instanceof DirectoryRequestError && [401, 403].includes(caught.status)) hideAccess();
      else setError(caught instanceof Error ? caught.message : "Import sa nepodaril.");
    } finally { setImporting(false); finishMutation(); }
  }

  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm" aria-label="Adresár firiem, pobočiek a kontaktov">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-zinc-200 p-4 sm:p-6">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-yellow-100 text-zinc-900"><BookUser size={22} aria-hidden="true" /></span>
          <div className="min-w-0"><h2 className="text-xl font-bold tracking-tight text-zinc-950">Adresár</h2><p className="mt-1 max-w-lg text-sm leading-relaxed text-zinc-500">Firmy, asistencia, pobočky a ľudia. Všetko na jednom mieste.</p></div>
        </div>
        {!accessHidden && data?.canEdit && <button type="button" disabled={Boolean(editor && editorPaused)} onClick={() => openEditor({ mode: "create", kind: kind === "all" ? "company" : kind })} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#FCD703] px-4 text-sm font-semibold text-zinc-950 hover:bg-yellow-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-500 focus-visible:ring-offset-2 disabled:opacity-50 sm:w-auto"><Plus size={18} />Pridať záznam</button>}
      </header>

      <div hidden={accessHidden} className="space-y-4 border-b border-zinc-200 bg-zinc-50/60 p-4 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row">
          <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-zinc-200 bg-white px-3 focus-within:ring-2 focus-within:ring-yellow-300">
            <Search size={18} className="shrink-0 text-zinc-400" aria-hidden="true" /><input aria-label="Hľadať v adresári" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="Meno, firma, telefón, IČO alebo adresa…" className="min-w-0 flex-1 bg-transparent py-2.5 text-base text-zinc-900 outline-none placeholder:text-zinc-400 sm:text-sm" />
            {query && <button type="button" aria-label="Vymazať hľadanie" onClick={() => { setQuery(""); setPage(0); }} className="flex h-9 w-9 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100"><X size={16} /></button>}
          </label>
          <div className="flex items-center gap-2"><label className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-3"><Archive size={15} className="text-zinc-400" aria-hidden="true" /><select aria-label="Stav záznamov" value={status} onChange={event => { setStatus(event.target.value as typeof status); setPage(0); }} className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none"><option value="active">Aktívne záznamy</option><option value="archived">Archivované</option><option value="all">Všetky stavy</option></select></label></div>
        </div>
        <div className="flex flex-wrap gap-1.5" aria-label="Typ záznamu">
          {(["all", ...DIRECTORY_KINDS] as const).map(type => {
            const Icon = type === "all" ? BookUser : DIRECTORY_ICONS[type];
            return <button key={type} type="button" aria-pressed={kind === type} onClick={() => { setKind(type); setPage(0); }} className={`inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium transition ${kind === type ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-200/70"}`}><Icon size={15} aria-hidden="true" />{type === "all" ? "Všetko" : DIRECTORY_FILTERS[type]}<span className={`rounded px-1.5 py-0.5 text-xs tabular-nums ${kind === type ? "bg-white/15 text-white" : "bg-zinc-200/70 text-zinc-600"}`}>{counts[type]}</span></button>;
          })}
        </div>
      </div>

      {!accessHidden && notice && <div role="status" className="mx-4 mt-4 flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800 sm:mx-6"><Check size={17} className="mt-0.5 shrink-0" /><span className="flex-1">{notice}</span><button type="button" aria-label="Zavrieť oznámenie" onClick={() => setNotice(null)} className="p-1"><X size={15} /></button></div>}
      {!accessHidden && editor && editorPaused && <div role="status" className="m-4 flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700 sm:mx-6"><span>Prístup k adresáru je obnovený. Otvorený záznam zostal zachovaný.</span><button type="button" onClick={() => setEditorPaused(false)} className="min-h-11 rounded-lg border border-zinc-300 bg-white px-3 font-semibold">Pokračovať v rozpracovanom zázname</button></div>}
      {error && <div role="alert" className="m-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 sm:mx-6">{error}<button type="button" disabled={loading} onClick={() => void reload()} className="ml-2 font-semibold underline disabled:opacity-50">Skúsiť znova</button></div>}
      <div hidden={accessHidden} inert={accessHidden}>
      {loading && !data ? <div role="status" className="space-y-4 p-6"><span className="sr-only">Načítavam adresár…</span>{[0, 1, 2, 3].map(index => <div key={index} className="h-14 animate-pulse rounded-lg bg-zinc-100" />)}</div> : data && visible.length === 0 ? <div className="flex flex-col items-center px-5 py-14 text-center"><Search size={30} className="mb-3 text-zinc-300" /><h3 className="font-semibold text-zinc-900">{query ? "Žiadny záznam nezodpovedá hľadaniu" : status === "archived" ? "Archív je prázdny" : "Zatiaľ tu nie sú žiadne záznamy"}</h3><p className="mt-2 max-w-md text-sm text-zinc-500">{query ? "Skúste časť názvu, telefón alebo zrušte filtre." : status === "archived" ? "Archivované firmy zostávajú uložené a môžete ich kedykoľvek obnoviť." : "Pridajte firmu, pobočku alebo kontakt. Asistenčné spoločnosti môžete prevziať aj z existujúcich prípadov."}</p>{(query || kind !== "all" || status !== "active") && <button type="button" onClick={() => { setQuery(""); setKind("all"); setStatus("active"); setPage(0); }} className="mt-4 min-h-11 rounded-lg border border-zinc-200 px-4 text-sm font-semibold text-zinc-700">Vyčistiť filtre</button>}</div> : data && <>
        <div className="hidden grid-cols-[minmax(180px,1.25fr)_minmax(160px,1fr)_minmax(130px,1fr)_80px_24px] gap-4 border-b border-zinc-100 px-6 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-400 lg:grid"><span>Názov a typ</span><span>Kontakt</span><span>Adresa / prepojenie</span><span>Stav</span><span /></div>
        <div className="divide-y divide-zinc-100">{visible.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(entry => {
          const Icon = DIRECTORY_ICONS[entry.kind];
          const relations = directoryRelations(entry, entries);
          return <button type="button" key={directoryKey(entry)} disabled={Boolean(editor && editorPaused)} onClick={() => openEditor({ mode: "view", entry })} className="group grid w-full min-w-0 grid-cols-[minmax(0,1fr)_20px] gap-x-3 gap-y-2 px-4 py-4 text-left transition hover:bg-yellow-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-yellow-400 disabled:opacity-60 sm:px-6 lg:grid-cols-[minmax(180px,1.25fr)_minmax(160px,1fr)_minmax(130px,1fr)_80px_24px] lg:items-center lg:gap-4" aria-label={`Otvoriť ${entry.name}`}>
            <span className="flex min-w-0 items-center gap-3"><span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${entry.kind === "assistance" ? "bg-amber-100 text-amber-800" : entry.kind === "branch" ? "bg-emerald-50 text-emerald-700" : entry.kind === "contact" ? "bg-blue-50 text-blue-700" : "bg-zinc-100 text-zinc-600"}`}><Icon size={18} /></span><span className="min-w-0"><span className="block truncate font-semibold text-zinc-900">{entry.name}</span><span className="mt-0.5 block truncate text-xs text-zinc-500">{DIRECTORY_LABELS[entry.kind]}{entry.ico ? ` · IČO ${entry.ico}` : ""}</span></span></span>
            <span className="col-start-1 min-w-0 pl-[52px] text-sm lg:col-start-auto lg:pl-0"><span className="block truncate text-zinc-700">{entry.phone || entry.email || "Kontakt nie je doplnený"}</span>{entry.phone && entry.email && <span className="mt-0.5 block truncate text-xs text-zinc-400">{entry.email}</span>}</span>
            <span className="col-start-1 min-w-0 pl-[52px] text-xs leading-relaxed text-zinc-500 lg:col-start-auto lg:pl-0">{entry.address && <span className="block truncate">{entry.address}</span>}{relations.length > 0 ? <span className="block truncate">{relations.map(item => item.name).join(", ")}</span> : entry.contactIds.length > 0 ? <span>{entry.contactIds.length} kontaktných osôb</span> : !entry.address && <span className="hidden lg:inline">—</span>}</span>
            <span className="col-start-1 pl-[52px] lg:col-start-auto lg:pl-0">{!entry.active ? <span className="rounded-full bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-500">V archíve</span> : <span className="hidden items-center gap-1.5 text-xs text-zinc-500 lg:inline-flex"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Aktívny</span>}</span>
            <ArrowRight size={17} className="col-start-2 row-start-1 self-center text-zinc-300 transition group-hover:translate-x-0.5 group-hover:text-zinc-600 lg:col-start-auto lg:row-start-auto" />
          </button>;
        })}</div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 px-4 py-3 sm:px-6"><span className="text-xs text-zinc-500">{currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, visible.length)} z {visible.length} záznamov</span>{visible.length > PAGE_SIZE && <div className="flex items-center gap-2"><button aria-label="Predchádzajúca strana adresára" type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="rounded-lg border border-zinc-200 p-2.5 disabled:opacity-30"><ChevronLeft size={17} /></button><span className="text-xs tabular-nums text-zinc-500">{currentPage + 1} / {Math.ceil(visible.length / PAGE_SIZE)}</span><button aria-label="Nasledujúca strana adresára" type="button" disabled={(currentPage + 1) * PAGE_SIZE >= visible.length} onClick={() => setPage(currentPage + 1)} className="rounded-lg border border-zinc-200 p-2.5 disabled:opacity-30"><ChevronRight size={17} /></button></div>}</div>
      </>}
      {data?.canEdit && <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-100 bg-zinc-50/70 px-4 py-3 sm:px-6"><p className="text-xs text-zinc-500">Chýbajú vám používané asistenčné spoločnosti?</p><button type="button" onClick={() => void importAssistance()} disabled={importing || loading} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 disabled:opacity-50">{importing ? <Loader2 size={15} className="animate-spin" /> : <FolderDown size={15} />}Prevziať z prípadov</button></footer>}
      </div>
      {editor && data && <DirectoryEntryDialog key={editor.mode === "create" ? "create" : `${editor.mode}:${directoryKey(editor.entry)}`} editor={editor} entries={entries} canEdit={data.canEdit && !accessHidden} accessHidden={accessHidden || editorPaused} onClose={() => setEditor(null)} onEdit={entry => openEditor({ mode: "edit", entry })} onOpen={entry => openEditor({ mode: "view", entry })} onNewContact={owner => openEditor({ mode: "create", kind: "contact", owner })} onSave={save} onDial={onDial} />}
    </section>
  );
}
