"use client";

import { useEffect, useRef, useState } from "react";
import type { SmsCaseOption, SmsConversationEntry, SmsInboxMessage } from "@/lib/sms/contracts";
import { smsStatusLabel } from "@/lib/sms/status";

const button = "rounded-lg border border-zinc-300 px-3 py-2 text-sm font-semibold disabled:opacity-40";
const field = "w-full min-w-0 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm disabled:opacity-50";
type Operator = { id: string; name: string };
type InboxData = { messages: SmsInboxMessage[]; hasMore: boolean; unreadCount: number; operators: Operator[] };
type ConversationData = { message: SmsInboxMessage; messages: SmsConversationEntry[]; hasMore: boolean };

async function readResponse<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "SMS sa nepodarilo načítať.");
  return data as T;
}

export function useSmsUnreadCount() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function refresh() {
      if (pending || controller.signal.aborted) return;
      pending = true;
      try {
        const result = await readResponse<{ unreadCount: number }>(await fetch("/api/sms/inbox?summary=true", { cache: "no-store", signal: controller.signal }));
        if (!controller.signal.aborted) setCount(result.unreadCount);
      } catch { /* Keep the last known count; the inbox displays read errors. */ }
      finally { pending = false; }
    }
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 10_000);
    window.addEventListener("sms-history-changed", refresh);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener("sms-history-changed", refresh); };
  }, []);
  return count;
}

export function SmsInbox({ cases, repliesEnabled, onReply, replyDisabled, onCreateCase }: {
  cases: SmsCaseOption[];
  repliesEnabled: boolean | null;
  onReply: (message: SmsInboxMessage) => void;
  replyDisabled: boolean;
  onCreateCase?: () => void;
}) {
  const [filter, setFilter] = useState<"all" | "unread" | "unassigned">("all");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [data, setData] = useState<InboxData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function refresh() {
      if (pending || controller.signal.aborted) return;
      pending = true;
      try {
        const result = await readResponse<InboxData>(await fetch(`/api/sms/inbox?filter=${filter}&offset=${offset}`, { cache: "no-store", signal: controller.signal }));
        if (!controller.signal.aborted) { setData(result); setError(""); }
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Prijaté SMS nie sú dostupné."); }
      finally { pending = false; }
    }
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 10_000);
    window.addEventListener("sms-history-changed", refresh);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener("sms-history-changed", refresh); };
  }, [filter, offset]);
  if (selectedId) return <SmsConversation key={selectedId} id={selectedId} cases={cases} operators={data?.operators ?? []}
    onBack={() => setSelectedId(null)} onReply={onReply} replyDisabled={replyDisabled} onCreateCase={onCreateCase} />;
  return <div className="grid gap-3">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-bold">Prijaté SMS {data ? `(${data.unreadCount} neprečítaných)` : ""}</h3>
      <select aria-label="Filter prijatých SMS" className={field + " sm:w-auto"} value={filter} onChange={(event) => { setFilter(event.target.value as typeof filter); setOffset(0); setData(null); }}>
        <option value="all">Všetky prijaté</option><option value="unread">Neprečítané</option><option value="unassigned">Bez priradeného prípadu</option>
      </select>
    </div>
    {repliesEnabled === false && <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-sm leading-6 text-amber-950">
      <p className="font-semibold">Príjem odpovedí SMS nie je aktívny.</p>
      <p>Klient má použiť kontaktný telefón uvedený v SMS. Odpovede sprístupníme po overení vhodného čísla.</p>
    </div>}
    <p className="text-xs leading-5 text-zinc-500">Nová správa začína bez prípadu. Telefónne číslo môže patriť k viacerým prípadom; priradenie vyberá dispečer.</p>
    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
    {!data && !error && <p role="status">Načítavam prijaté SMS…</p>}
    {data?.messages.length === 0 && <p className="rounded-lg bg-zinc-50 p-4 text-sm">Žiadne prijaté SMS v tomto výbere.</p>}
    {data?.messages.map((message) => <button key={message.id} type="button" onClick={() => setSelectedId(message.id)} className={`min-w-0 rounded-xl border p-3.5 text-left text-sm ${message.unread ? "border-yellow-400 bg-yellow-50" : "border-zinc-200 bg-white"}`}>
      <span className="flex flex-wrap justify-between gap-2"><strong>{message.from}</strong>{message.unread && <span className="font-semibold">Neprečítaná</span>}</span>
      <span className="mt-1 block text-xs text-zinc-600">{message.caseNumber || "Bez prípadu"} · {message.assignedName || "Bez dispečera"} · {new Date(message.createdAt).toLocaleString("sk-SK")}</span>
      <span className="mt-2 block whitespace-pre-wrap break-words">{message.body || (message.hasMedia ? "Prijatá príloha" : "Prázdna správa")}</span>
    </button>)}
    {(offset > 0 || data?.hasMore) && <div className="flex justify-between gap-2"><button type="button" disabled={offset === 0} className={button} onClick={() => { setOffset(offset - 50); setData(null); }}>Novšie</button><button type="button" disabled={!data?.hasMore} className={button} onClick={() => { setOffset(offset + 50); setData(null); }}>Staršie</button></div>}
  </div>;
}

function SmsConversation({ id, cases, operators, onBack, onReply, replyDisabled, onCreateCase }: {
  id: string; cases: SmsCaseOption[]; operators: Operator[]; onBack: () => void;
  onReply: (message: SmsInboxMessage) => void; replyDisabled: boolean; onCreateCase?: () => void;
}) {
  const [data, setData] = useState<ConversationData | null>(null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [assignment, setAssignment] = useState<{ caseId: string; assignedProfileId: string; version: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function refresh() {
      if (pending || controller.signal.aborted) return;
      pending = true;
      try {
        const result = await readResponse<ConversationData>(await fetch(`/api/sms/inbox/${encodeURIComponent(id)}?offset=${offset}`, { cache: "no-store", signal: controller.signal }));
        if (!controller.signal.aborted) { setData(result); setError(""); }
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Konverzácia nie je dostupná."); }
      finally { pending = false; }
    }
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 10_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [id, offset, revision]);
  async function update(body: object) {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true); setError("");
    try {
      await readResponse(await fetch(`/api/sms/inbox/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }));
      setAssignment(null); setData(null); setRevision((value) => value + 1);
      window.dispatchEvent(new Event("sms-history-changed"));
    } catch (error) { setError(error instanceof Error ? error.message : "Úpravu sa nepodarilo uložiť."); }
    finally { savingRef.current = false; setSaving(false); }
  }
  function editAssignment(key: "caseId" | "assignedProfileId", value: string) {
    if (!data) return;
    setAssignment((current) => ({ ...(current ?? { caseId: data.message.caseId ?? "", assignedProfileId: data.message.assignedProfileId ?? "", version: data.message.version }), [key]: value }));
  }
  const message = data?.message;
  const caseId = assignment?.caseId ?? message?.caseId ?? "";
  const assignedId = assignment?.assignedProfileId ?? message?.assignedProfileId ?? "";
  return <div className="grid gap-4">
    <div className="flex flex-wrap justify-between gap-2"><button type="button" className={button} disabled={saving} onClick={onBack}>Späť na prijaté SMS</button><button type="button" className={button} disabled={saving} onClick={() => { setAssignment(null); setRevision((value) => value + 1); }}>Obnoviť konverzáciu</button></div>
    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
    {!message && !error && <p role="status">Načítavam konverzáciu…</p>}
    {message && <>
      <div><h3 className="font-bold">Konverzácia s {message.from}</h3><p className="text-xs text-zinc-500">Naše číslo: {message.to}. Každá správa má vlastné priradenie k prípadu.</p></div>
      <div className="grid gap-3 rounded-xl border border-yellow-200 bg-yellow-50 p-3">
        <p className="text-sm font-semibold">Vybraná prijatá správa · {new Date(message.createdAt).toLocaleString("sk-SK")}</p>
        <p className="whitespace-pre-wrap break-words text-sm">{message.body || "Prijatá správa bez textu"}</p>
        {message.hasMedia && <p className="text-xs">Správa obsahuje prílohu. Náhľad príloh zatiaľ nie je dostupný.</p>}
        <label className="grid min-w-0 gap-1 text-sm">Priradiť správu k prípadu<select aria-label="Prípad prijatej SMS" className={field} value={caseId} disabled={saving} onChange={(event) => editAssignment("caseId", event.target.value)}>
          <option value="">Bez prípadu</option>
          {caseId && !cases.some((item) => item.id === caseId) && <option value={caseId}>{message.caseNumber || caseId}</option>}
          {cases.map((item) => <option key={item.id} value={item.id}>{item.caseNumber} · {item.name} · {item.phone}</option>)}
        </select></label>
        <label className="grid min-w-0 gap-1 text-sm">Priradený dispečer<select aria-label="Dispečer prijatej SMS" className={field} value={assignedId} disabled={saving} onChange={(event) => editAssignment("assignedProfileId", event.target.value)}>
          <option value="">Bez dispečera</option>
          {assignedId && !operators.some((item) => item.id === assignedId) && <option value={assignedId}>{message.assignedName || "Neaktívny dispečer"}</option>}
          {operators.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        {assignment && <button type="button" className={button} disabled={saving} onClick={() => void update({ ...assignment, caseId: assignment.caseId || null, assignedProfileId: assignment.assignedProfileId || null })}>Uložiť priradenie tejto správy</button>}
        {assignment && assignment.version !== message.version && <p role="alert" className="text-xs text-red-800">Priradenie medzičasom zmenil kolega. Obnovte konverzáciu pred uložením.</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={saving} onClick={() => void update({ read: message.unread })}>{message.unread ? "Označiť ako prečítanú" : "Označiť ako neprečítanú"}</button>
          {onCreateCase && <button type="button" className={button} disabled={saving} onClick={onCreateCase}>Vytvoriť nový prípad</button>}
          <button type="button" className={button + " bg-zinc-950 text-white"} disabled={saving || replyDisabled || !message.canReply || Boolean(assignment)} onClick={() => onReply(message)}>Napísať odpoveď</button>
        </div>
        {assignment && <p className="text-xs">Pred odpoveďou uložte priradenie správy.</p>}
        {replyDisabled && <p className="text-xs">V editore najprv overte výsledok predchádzajúceho odoslania.</p>}
        {!message.canReply && <p className="text-xs">Odpoveď z tohto čísla zatiaľ nie je dostupná.</p>}
      </div>
      {(offset > 0 || data.hasMore) && <div className="flex justify-between gap-2"><button type="button" className={button} disabled={!data.hasMore || saving} onClick={() => setOffset(offset + 50)}>Staršie správy</button><button type="button" className={button} disabled={offset === 0 || saving} onClick={() => setOffset(Math.max(0, offset - 50))}>Novšie správy</button></div>}
      <div className="grid gap-3" aria-label="Správy konverzácie">{data.messages.map((entry) => <article key={entry.id} className={`max-w-[94%] rounded-xl p-3 text-sm ${entry.direction === "outbound" ? "justify-self-end border border-zinc-200 bg-zinc-50" : "justify-self-start border border-sky-100 bg-sky-50"}`}>
        <p className="text-xs font-semibold">{entry.direction === "inbound" ? "Klient" : "Dispečing"} · {entry.caseNumber || "Bez prípadu"}</p>
        <p className="my-2 whitespace-pre-wrap break-words">{entry.body || "Správa bez textu"}</p>
        <p className="text-xs text-zinc-500">{new Date(entry.createdAt).toLocaleString("sk-SK")} · {smsStatusLabel(entry.status, entry.statusDetail)}</p>
      </article>)}</div>
    </>}
  </div>;
}
