"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowLeft, LockKeyhole, Plus, Save, Share2, Trash2 } from "lucide-react";
import { NOTE_BODY_LIMIT, NOTE_REVALIDATE_MS, NOTE_TITLE_LIMIT } from "@/domain/notes";
import { protectDraftBeforeUnload } from "@/lib/draft-unload";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { NotebookStore } from "./notebook-store";
import styles from "./NotebookPanel.module.css";

export type NotebookEditorState = { hasPendingChanges?: () => boolean; dirty: boolean; saving: boolean; save: () => Promise<boolean>; discard: () => void };
export type NotebookProviderProps = { enabled?: boolean; actorKey: string; viewerProfileId?: string; onEditorStateChange?: (state: NotebookEditorState) => void; children: ReactNode };
const NotebookContext = createContext<NotebookStore | null>(null);

/** Keep this provider mounted across widget/page navigation. No note text is persisted. */
export function NotebookProvider(props: NotebookProviderProps) {
  return <NotebookSession key={`${props.actorKey}:${props.viewerProfileId ?? ""}`} {...props} />;
}

function NotebookSession({ actorKey, viewerProfileId, onEditorStateChange, children, enabled = true }: NotebookProviderProps) {
  const [store] = useState(() => new NotebookStore(undefined, enabled));
  useLayoutEffect(() => { store.setEnabled(enabled); }, [store, enabled]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const dirty = Object.keys(state.drafts).length > 0;
  useEffect(() => {
    onEditorStateChange?.({ dirty, saving: state.saving, save: store.save, discard: store.discard, hasPendingChanges: () => Object.keys(store.getSnapshot().drafts).length > 0 || store.getSnapshot().saving });
  }, [dirty, state.saving, store, onEditorStateChange]);
  useEffect(() => {
    if (!viewerProfileId || !enabled) return;
    void store.refresh(); void store.loadColleagues();
    const refresh = () => { if (document.visibilityState === "visible" && navigator.onLine) void store.refresh(); };
    const resume = () => { if (document.visibilityState === "visible") { void store.reauthorize(); void store.loadColleagues(); } };
    const interval = window.setInterval(refresh, NOTE_REVALIDATE_MS);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    let cleanupAuth: (() => void) | undefined;
    let cleanupChannel: (() => void) | undefined;
    try {
      const client = createSupabaseBrowserClient();
      let sessionUserId: string | undefined;
      const { data } = client.auth.onAuthStateChange((event, session) => {
        if (!session || event === "SIGNED_OUT" || (sessionUserId && session.user.id !== sessionUserId)) store.dispose();
        if (session?.user.id) sessionUserId = session.user.id;
      });
      cleanupAuth = () => data.subscription.unsubscribe();
      // actorKey is normally org:profile. The server authorizes this exact topic
      // against auth.uid(), active organization and profile membership.
      const organizationId = actorKey.split(":")[0];
      const channel = client.channel(`notebook:${organizationId}:${viewerProfileId}`, { config: { private: true } })
        .on("broadcast", { event: "invalidate" }, () => { void store.refresh(); })
        .subscribe();
      cleanupChannel = () => { void client.removeChannel(channel); };
    } catch { /* 25-second ACL checks also work without Realtime configuration. */ }
    return () => {
      window.clearInterval(interval); window.removeEventListener("focus", resume); window.removeEventListener("online", resume); document.removeEventListener("visibilitychange", resume);
      cleanupAuth?.(); cleanupChannel?.(); store.clear();
    };
  }, [actorKey, viewerProfileId, store, enabled]);
  useEffect(() => {
    if (!enabled || !dirty || state.saving || state.error || state.hidden || state.conflicts.length > 0) return;
    const timer = window.setTimeout(() => { void store.save(); }, 800);
    return () => window.clearTimeout(timer);
  }, [enabled, dirty, state.drafts, state.saving, state.error, state.hidden, state.conflicts.length, store]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty || state.saving) protectDraftBeforeUnload(event); };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty, state.saving]);
  return <NotebookContext.Provider value={store}>{children}</NotebookContext.Provider>;
}

export function NotebookPanel({ active = true, compact = false }: { active?: boolean; compact?: boolean }) {
  const store = useContext(NotebookContext);
  if (!store) throw new Error("NotebookPanel requires NotebookProvider");
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const selected = state.notes.find(note => note.id === state.selectedId);
  const draft = selected && (state.drafts[selected.id] ?? selected);
  const dirty = Object.keys(state.drafts).length > 0;
  if (!active) return null;
  if (!store.enabled) return <section className={styles.panel} aria-label="Osobné poznámky"><h2>Poznámky</h2><p>Poznámky budú dostupné po aktivácii bezpečného úložiska.</p></section>;
  return <section className={`${styles.panel} ${compact ? styles.compact : ""}`} aria-label="Osobné poznámky">
    <header className={styles.header}><h2>Poznámky</h2><button type="button" onClick={() => { setConfirmDelete(null); void store.create(); }} disabled={state.saving || state.hidden} aria-label="Nová súkromná poznámka"><Plus size={17} />Nová</button></header>
    <div className={styles.status} role="status">{state.saving ? "Ukladám…" : state.hidden ? "Overujem prístup…" : state.loading ? "Aktualizujem…" : dirty ? "Neuložené zmeny" : "Uložené"}</div>
    {state.error && <div className={styles.error} role="alert">{state.error}<button type="button" onClick={() => { void (state.hidden || !dirty ? store.reauthorize() : store.save()); }} disabled={state.saving}>Skúsiť znova</button></div>}
    {state.hidden ? <p>Obsah bude dostupný po overení prístupu.</p> : selected && draft ? <div className={styles.editor}>
      <div className={styles.actions}><button type="button" onClick={() => { store.select(null); setConfirmDelete(null); }}><ArrowLeft size={16} />Zoznam</button><span>{selected.canEdit ? draft.recipientProfileIds.length ? <><Share2 size={14} />Zdieľaná</> : <><LockKeyhole size={14} />Súkromná</> : "Zdieľaná so mnou · iba čítanie"}</span></div>
      <label>Názov<input value={draft.title} maxLength={NOTE_TITLE_LIMIT} readOnly={!selected.canEdit} placeholder="Bez názvu" onChange={event => store.edit(selected.id, { title: event.target.value })} /></label>
      <label>Text poznámky<textarea value={draft.body} maxLength={NOTE_BODY_LIMIT} readOnly={!selected.canEdit} rows={compact ? 7 : 15} onChange={event => store.edit(selected.id, { body: event.target.value })} /></label>
      {selected.canEdit && <>
        <details><summary><Share2 size={15} />Zdieľať s kolegami ({draft.recipientProfileIds.length})</summary><p>Vybraní kolegovia môžu poznámku iba čítať. Bez výberu zostáva súkromná.</p>
          <div className={styles.colleagues}>{state.colleagues.length === 0 && <p>Nie sú dostupní žiadni kolegovia.</p>}{state.colleagues.map(colleague => <label key={colleague.id}><input type="checkbox" checked={draft.recipientProfileIds.includes(colleague.id)} onChange={event => store.edit(selected.id, { recipientProfileIds: event.target.checked ? [...draft.recipientProfileIds, colleague.id] : draft.recipientProfileIds.filter(id => id !== colleague.id) })} />{colleague.displayName}</label>)}
          {draft.recipientProfileIds.filter(id => !state.colleagues.some(colleague => colleague.id === id)).map(id => <label key={id}><input type="checkbox" checked onChange={() => store.edit(selected.id, { recipientProfileIds: draft.recipientProfileIds.filter(value => value !== id) })} />Nedostupný kolega — zrušiť zdieľanie</label>)}</div>
        </details>
        {state.conflicts.includes(selected.id) && <div className={styles.error} role="alert">Táto poznámka má novšiu verziu. Rozpracovaný text zostal zachovaný.<button type="button" onClick={() => { if (window.confirm("Zahodiť rozpracované zmeny tejto poznámky a načítať aktuálnu verziu?")) void store.reloadSelected(); }}>Načítať aktuálnu verziu</button></div>}
        <div className={styles.actions}><button type="button" onClick={() => { void store.save(); }} disabled={!dirty || state.saving || state.conflicts.includes(selected.id)}><Save size={16} />Uložiť</button><button type="button" onClick={() => setConfirmDelete(selected.id)} disabled={state.saving}><Trash2 size={16} />Vymazať</button></div>
        {confirmDelete === selected.id && <div className={styles.confirm} role="alert"><p>Vymazať túto poznámku aj pre jej čitateľov?</p><button type="button" disabled={state.saving} onClick={() => { setConfirmDelete(null); void store.deleteSelected(); }}>Vymazať poznámku</button><button type="button" onClick={() => setConfirmDelete(null)}>Zrušiť</button></div>}
      </>}
    </div> : <>
      <label className={styles.search}>Hľadať v mojich a zdieľaných poznámkach<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <ul className={styles.list}>{state.notes.filter(note => `${note.title}\n${note.body}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(note => <li key={note.id}><button type="button" onClick={() => { store.select(note.id); setConfirmDelete(null); }}><strong>{state.drafts[note.id]?.title || note.title || "Bez názvu"}{state.drafts[note.id] ? " •" : ""}</strong><span>{note.canEdit ? note.recipientProfileIds.length ? "Zdieľaná" : "Súkromná" : "Zdieľaná so mnou"}</span></button></li>)}</ul>
      {!state.loading && state.notes.length === 0 && <p>Tu si môžete uložiť súkromné poznámky a vybrané zdieľať s kolegami.</p>}
    </>}
  </section>;
}
