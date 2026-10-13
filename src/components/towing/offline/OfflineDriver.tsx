'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { parseEuroCents } from '@/domain/towing/money';
import type { TowingFields } from '@/domain/towing/types';
import { towingClient } from '../client';
import { prepareTowingImage } from '../images';
import { towingFieldsPatch } from '../model';
import { accessOrder, synchronize, type DriverAccess } from './sync';
import { editOrder, enqueue, lockScope, pendingSummary, readOrders, readReceiptEvidence, rememberOrder, scopesForUser, type OfflineEntry, type OfflineIdentity, type OfflineOrder, type ReceiptEvidence } from './store';

const button = 'min-h-11 rounded-lg bg-zinc-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40';
const input = 'mt-1 min-h-11 w-full rounded-lg border border-zinc-300 bg-white p-3 text-base text-zinc-950';
const card = 'rounded-xl border border-zinc-200 bg-white p-5';
type Summary = { changes: number; photos: number; receipts: number };

/** Public HTML contains no customer content. Private data is loaded only after matching the local session identity. */
export function OfflineDriver() {
  const [identity, setIdentity] = useState<OfflineIdentity | null>(null);
  const identityRef = useRef<OfflineIdentity | null>(null);
  const [orders, setOrders] = useState<OfflineOrder[]>([]);
  const [evidence, setEvidence] = useState<ReceiptEvidence[]>([]);
  const [candidate, setCandidate] = useState<DriverAccess | null>(null);
  const [consent, setConsent] = useState(false);
  const [summary, setSummary] = useState<Summary>({ changes: 0, photos: 0, receipts: 0 });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Overujem účet v tomto zariadení…');
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [checkedAt, setCheckedAt] = useState(() => Date.now());

  const refresh = useCallback(async (scope = identityRef.current) => {
    if (!scope) return;
    setCheckedAt(Date.now());
    const session = (await createSupabaseBrowserClient().auth.getSession()).data.session;
    if (!session || session.user.id !== scope.userId || (session.expires_at ?? 0) * 1000 <= Date.now()) {
      await lockScope(scope).catch(() => undefined); setOrders([]);
      setError('Prihlásenie vypršalo alebo sa zmenilo. Neodoslané údaje ostali zamknuté. Prihláste pôvodný účet online.'); return;
    }
    setSummary(await pendingSummary(scope));
    setEvidence(await readReceiptEvidence(scope));
    try {
      setOrders(await readOrders(scope));
      setExpiresAt((await scopesForUser(scope.userId, scope.environment)).find(s => s.membershipId === scope.membershipId)?.lease.expiresAt ?? null);
    } catch (caught) { setOrders([]); setError(caught instanceof Error ? caught.message : 'Offline prístup je zamknutý.'); }
  }, []);

  const sync = useCallback(async () => {
    const scope = identityRef.current;
    if (!scope) return;
    setBusy(true); setError(null);
    try {
      await synchronize(scope, {
        currentUser: async () => (await createSupabaseBrowserClient().auth.getUser()).data.user?.id ?? null,
        onChange: () => { void refresh(scope); },
      });
      const remaining = await pendingSummary(scope);
      setMessage(remaining.changes ? 'Niektoré záznamy čakajú na vyriešenie. Skontrolujte ich stav nižšie.' : 'Všetky odoslané záznamy sú potvrdené.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Spojenie sa nepodarilo obnoviť. Údaje ostali v zariadení.'); }
    finally { await refresh(scope); setBusy(false); }
  }, [refresh]);

  useEffect(() => {
    let live = true;
    let client: ReturnType<typeof createSupabaseBrowserClient>;
    try { client = createSupabaseBrowserClient(); }
    catch {
      queueMicrotask(() => { if (live) setError('Aplikácia nemá nastavené pripojenie. Neodoslané údaje ostávajú v zariadení.'); });
      return () => { live = false; };
    }
    async function initialize() {
      try {
        const { data: { session } } = await client.auth.getSession();
        if (!live) return;
        setOnline(navigator.onLine);
        if (!session) { setMessage('Pre prípravu offline práce sa najprv prihláste online.'); return; }
        const scopes = await scopesForUser(session.user.id, location.origin);
        if (scopes[0]) {
          identityRef.current = scopes[0]; setIdentity(scopes[0]); setConsent(true);
          await refresh(scopes[0]); setMessage('Práca pripravená v tomto zariadení.');
        }
        const orderId = new URL(location.href).searchParams.get('orderId');
        if (navigator.onLine && orderId) {
          const workspace = await towingClient.workspace('driver', { orderId });
          if (!live || workspace.actor.userId !== session.user.id) return;
          const scope: OfflineIdentity = { userId: session.user.id, organizationId: workspace.actor.organizationId, membershipId: workspace.actor.id, environment: location.origin };
          const verified = await accessOrder(scope, orderId);
          if (!live) return;
          identityRef.current = scope; setIdentity(scope); setCandidate(verified); setMessage('Pripravte zákazku pred odchodom bez signálu.');
        } else if (navigator.onLine && scopes[0]) await sync();
        else if (!scopes.length) setMessage('V tomto účte zatiaľ nie je pripravená žiadna offline zákazka.');
      } catch (caught) { if (live) setError(caught instanceof Error ? caught.message : 'Offline pracovný priestor nie je dostupný.'); }
    }
    void initialize();
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      const current = identityRef.current;
      if (current && (!session || session.user.id !== current.userId)) {
        void lockScope(current).catch(() => undefined);
        identityRef.current = null; setIdentity(null); setOrders([]); setEvidence([]); setCandidate(null);
        setMessage('Účet sa zmenil. Predchádzajúca práca ostala zamknutá. Otvorte pracovný priestor znova.');
      }
    });
    const connection = () => { setOnline(navigator.onLine); if (navigator.onLine) void sync(); };
    const resume = () => { if (document.visibilityState === 'visible') { void refresh(); if (navigator.onLine) void sync(); } };
    window.addEventListener('online', connection); window.addEventListener('offline', connection); document.addEventListener('visibilitychange', resume);
    const timer = window.setInterval(() => { void refresh(); }, 60_000);
    return () => { live = false; subscription.unsubscribe(); clearInterval(timer); window.removeEventListener('online', connection); window.removeEventListener('offline', connection); document.removeEventListener('visibilitychange', resume); };
  }, [refresh, sync]);

  async function prepare() {
    if (!identity || !candidate || !consent) return;
    setBusy(true); setError(null);
    try {
      const verified = await accessOrder(identity, candidate.order.id, candidate.order.assignmentGeneration);
      await rememberOrder(identity, verified.actor, verified.order, verified.lease);
      await navigator.storage?.persist?.().catch(() => false);
      await refresh(identity); setCandidate(null); setMessage('Zákazka je pripravená. Úpravy v tomto priestore sa najprv uložia v zariadení.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Zákazka sa neuložila.'); }
    finally { setBusy(false); }
  }
  return <main className="min-h-dvh bg-zinc-100 px-4 py-6 text-zinc-950"><div className="mx-auto max-w-3xl space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-widest text-zinc-500">Pomoc motoristom</p><h1 className="text-2xl font-bold">Práca v zariadení</h1></div><a className="min-h-11 rounded-lg border border-zinc-300 px-4 py-3 text-sm font-semibold" href="/vodic">Moje zákazky</a></header>
    <section className={card} aria-live="polite"><p className="font-semibold">{online ? 'Pripojenie dostupné' : 'Bez pripojenia'}</p><p className="mt-2 text-sm leading-6">{message}</p>
      <p className="mt-2 text-sm">Čaká {summary.changes} záznamov · {summary.photos} fotografií · {summary.receipts} príjmov hotovosti</p>
      {expiresAt && <p className={`mt-2 text-sm ${expiresAt - checkedAt < 3_600_000 ? 'font-semibold text-amber-800' : 'text-zinc-600'}`}>Offline prístup najneskôr do {new Date(expiresAt).toLocaleString('sk-SK')} a počas platného prihlásenia. Potom treba online overenie; neodoslaná práca sa nezmaže.</p>}
      <button className={`${button} mt-3`} disabled={busy || !identity || !online} onClick={() => void sync()}>{busy ? 'Overujem a odosielam…' : 'Synchronizovať'}</button>
    </section>
    {error && <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">{error}</p>}
    {candidate && <section className={card}><h2 className="font-bold">Pripraviť {candidate.order.number}</h2><p className="mt-2 text-sm">Uložia sa údaje vlastnej zákazky a neodoslaná práca. Použite svoje pracovné zariadenie. Vymazanie dát prehliadača môže odstrániť aj neodoslané záznamy.</p>
      <label className="mt-3 flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />Toto je moje pracovné zariadenie</label>
      <button className={button} disabled={!consent || busy || !online} onClick={() => void prepare()}>Uložiť zákazku pre offline prácu</button></section>}
    {identity && orders.map(record => <OfflineOrderForm key={record.key} identity={identity} record={record} busy={busy} refresh={() => refresh(identity)} />)}
    {evidence.length > 0 && <section className={card}><h2 className="font-bold">Hotovosť na overenie v kancelárii</h2><p className="mt-2 text-sm">Tieto príjmy sa automaticky neodosielajú. Odovzdajte hotovosť a pôvodný identifikátor kancelárii, aby sa tá istá platba nezapočítala dvakrát.</p>
      {evidence.map(receipt => <div key={receipt.key} className="mt-4 break-all border-t pt-3 text-sm"><p>{(receipt.amountCents / 100).toFixed(2)} € · {new Date(receipt.capturedAt).toLocaleString('sk-SK')}</p><p>Príjem: {receipt.receiptId}</p><p>Zákazka: {receipt.orderId} · pridelenie {receipt.assignmentGeneration}</p></div>)}</section>}
    {!orders.length && !candidate && <p className="p-3 text-sm text-zinc-600">Offline zákazku pripravíte cez tlačidlo „Pripraviť offline“ vo vlastnej zákazke. Zamknutú prácu obnoví overenie pôvodného účtu.</p>}
  </div></main>;
}

function OfflineOrderForm({ identity, record, busy, refresh }: { identity: OfflineIdentity; record: OfflineOrder; busy: boolean; refresh: () => Promise<void> }) {
  const initialFields = record.entries.filter(e => e.phase === 'fields').reduce((fields, entry) => ({ ...fields, ...(entry.command.payload.fields as Partial<TowingFields> ?? {}) }), { ...record.order.fields });
  const [fields, setFields] = useState(initialFields);
  const [cash, setCash] = useState('');
  const [cashConfirmed, setCashConfirmed] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [photoKind, setPhotoKind] = useState<'work' | 'handover'>('work');
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [current, setCurrent] = useState<DriverAccess | null>(null);
  const savingRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const fieldLabels = { startedAt: 'Začiatok', finishedAt: 'Koniec', destination: 'Cieľ', driverNotes: 'Poznámka', performedQuantity: 'Vykonané množstvo', photoException: 'Dôvod chýbajúcich fotografií' } as const;
  const dirty = (Object.keys(fieldLabels) as (keyof typeof fieldLabels)[]).some(key => (fields[key] ?? '') !== (initialFields[key] ?? ''));
  const submitted = record.entries.some(e => e.phase === 'submit');
  const disabled = busy || working || submitted;
  const makeEntry = (phase: OfflineEntry['phase'], type: OfflineEntry['command']['type'], payload: Record<string, unknown>): OfflineEntry => {
    const id = crypto.randomUUID();
    return { id, phase, state: 'pending', sealed: false, command: { commandId: id, type, targetId: record.order.id, expectedRevision: record.revision, assignmentGeneration: record.order.assignmentGeneration, payload } };
  };
  async function save(entry: OfflineEntry) {
    if (savingRef.current) return false;
    savingRef.current = true;
    setWorking(true); setNotice(null);
    try { await enqueue(identity, record.order.id, entry); setNotice('Uložené v zariadení — čaká na potvrdenie serverom.'); await refresh(); return true; }
    catch (caught) { setNotice(caught instanceof Error ? caught.message : 'Záznam sa neuložil.'); return false; }
    finally { savingRef.current = false; setWorking(false); }
  }
  function saveFields(event: FormEvent) {
    event.preventDefault();
    const allowed = towingFieldsPatch(fields, initialFields);
    void save(makeEntry('fields', 'update_order', { fields: allowed }));
  }
  async function savePhoto() {
    if (!file) return;
    if (!['image/jpeg','image/png'].includes(file.type) || file.size > 10 * 1024 * 1024) { setNotice('Použite JPEG alebo PNG do 10 MB. HEIC najprv exportujte ako JPEG.'); return; }
    try {
      const prepared = await prepareTowingImage(file);
      if (await save({ ...makeEntry('photo', 'attachment_intent', { id: crypto.randomUUID(), kind: photoKind }), file: prepared, fileName: prepared.name })) {
        setFile(null); if (fileInput.current) fileInput.current.value = '';
      }
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : 'Fotografia sa neuložila.'); }
  }
  async function resolveFields() {
    if (!current) return;
    try {
      await editOrder(identity, record.order.id, draft => {
        if (draft.entries.some(e => e.sealed && e.state !== 'conflict')) throw new Error('Najprv potvrďte výsledok rozpracovaného odoslania.');
        if (draft.entries.some(e => e.state === 'conflict' && e.phase !== 'fields')) throw new Error('Finančný alebo súborový konflikt musí overiť kancelária. Pôvodný príjem ostáva zachovaný.');
        draft.revision = current.order.revision; draft.order = { ...draft.order, fields: current.order.fields };
        for (const entry of draft.entries.filter(e => e.state === 'conflict')) {
          entry.command.commandId = crypto.randomUUID(); entry.id = entry.command.commandId;
          entry.sealed = false; entry.state = 'pending'; delete entry.error;
        }
      });
      setCurrent(null); await refresh();
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : 'Konflikt ostal nevyriešený.'); }
  }
  return <section className={card}><h2 className="text-lg font-bold">{record.order.number} · {record.order.fields.subjectDescription}</h2><p className="mt-1 text-sm text-zinc-600">{record.order.fields.pickup}</p>
    <form onSubmit={saveFields} className="mt-4 grid gap-3 sm:grid-cols-2">
      {([['startedAt','Začiatok'],['finishedAt','Koniec']] as const).map(([key, label]) => <label key={key} className="text-sm font-medium">{label}<input className={input} type="datetime-local" value={fields[key] ? localDate(fields[key]) : ''} disabled={disabled} onChange={e => setFields(f => ({ ...f, [key]: e.target.value ? new Date(e.target.value).toISOString() : '' }))} /></label>)}
      <label className="text-sm font-medium">Cieľ<input className={input} value={fields.destination ?? ''} disabled={disabled} onChange={e => setFields(f => ({ ...f, destination: e.target.value }))} /></label>
      <label className="text-sm font-medium">Vykonané množstvo<input className={input} inputMode="decimal" value={fields.performedQuantity ?? ''} disabled={disabled} onChange={e => setFields(f => ({ ...f, performedQuantity: e.target.value }))} /></label>
      <label className="text-sm font-medium sm:col-span-2">Poznámka k výkonu<textarea className={input} value={fields.driverNotes ?? ''} disabled={disabled} onChange={e => setFields(f => ({ ...f, driverNotes: e.target.value }))} /></label>
      <label className="text-sm font-medium sm:col-span-2">Dôvod chýbajúcich fotografií, ak ich nemožno urobiť<input className={input} value={fields.photoException ?? ''} disabled={disabled} onChange={e => setFields(f => ({ ...f, photoException: e.target.value }))} /></label>
      <button className={button} disabled={disabled}>Uložiť údaje v zariadení</button>
    </form>
    <div className="mt-5 border-t pt-4"><label className="text-sm font-medium">Typ fotografie<select className={input} value={photoKind} disabled={disabled} onChange={e => setPhotoKind(e.target.value as 'work' | 'handover')}><option value="work">Priebeh výkonu</option><option value="handover">Odovzdanie</option></select></label><label className="mt-3 block text-sm font-medium">Fotografia<input className={`${input} mb-2`} ref={fileInput} type="file" accept="image/jpeg,image/png" capture="environment" disabled={disabled} onChange={e => setFile(e.target.files?.[0] ?? null)} /></label><button className={button} disabled={disabled || !file} onClick={() => void savePhoto()}>Uložiť fotografiu</button></div>
    <div className="mt-5 border-t pt-4"><label className="text-sm font-medium">Skutočne prijatá hotovosť (€)<input className={`${input} mb-2`} inputMode="decimal" value={cash} disabled={disabled} onChange={e => { setCash(e.target.value); setCashConfirmed(false); }} /></label><p className="mb-2 text-sm text-zinc-600">Potvrdený zostatok sa zmení až po potvrdení serverom.</p><label className="mb-3 flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={cashConfirmed} disabled={disabled} onChange={e => setCashConfirmed(e.target.checked)} />Túto hotovosť som skutočne prijal.</label><button className={button} disabled={disabled || !cash || !cashConfirmed} onClick={() => {
      try { const amountCents = parseEuroCents(cash); if (amountCents <= 0) throw new Error('Suma musí byť vyššia ako nula.'); void save(makeEntry('receipt', 'receive_payment', { receiptId: crypto.randomUUID(), method: 'cash', amountCents, capturedAt: new Date().toISOString() })).then(saved => { if (saved) { setCash(''); setCashConfirmed(false); } }); }
      catch (caught) { setNotice(caught instanceof Error ? caught.message : 'Neplatná suma.'); }
    }}>Zaznamenať prijatú hotovosť</button></div>
    <div className="mt-5 border-t pt-4"><button className={button} disabled={disabled || dirty} onClick={() => void save(makeEntry('submit', 'submit', {}))}>Pripraviť dokončenie</button>{dirty && <p className="mt-2 text-sm text-amber-800">Najprv uložte upravené údaje výkonu.</p>}<p className="mt-2 text-sm text-zinc-600">Dokončenie sa odošle až po potvrdení údajov, fotografií a všetkých príjmov.</p></div>
    {record.entries.length > 0 && <ul className="mt-4 space-y-2 text-sm">{record.entries.map(entry => <li key={entry.id} className="rounded-lg bg-amber-50 p-3">{({ fields: 'Údaje výkonu', photo: 'Fotografia', receipt: 'Prijatá hotovosť', submit: 'Dokončenie' })[entry.phase]} — {entry.state === 'sending' ? 'odosiela sa' : entry.state === 'conflict' ? 'konflikt' : 'čaká na potvrdenie'}{entry.phase === 'receipt' && <span> · {(Number(entry.command.payload.amountCents) / 100).toFixed(2)} € · {String(entry.command.payload.receiptId)}</span>}{entry.error && <p className="mt-1">{entry.error}</p>}{['fields','submit'].includes(entry.phase) && (!entry.sealed || [400,409].includes(entry.lastHttpStatus ?? 0)) && <button className="mt-2 min-h-11 underline" onClick={() => { void editOrder(identity, record.order.id, draft => { draft.entries = draft.entries.filter(e => e.id !== entry.id); }).then(refresh).catch(e => setNotice(e.message)); }}>Zrušiť tento nepotvrdený záznam</button>}</li>)}</ul>}
    {record.entries.some(e => e.state === 'conflict') && <div className="mt-4"><button className={button} onClick={() => { void accessOrder(identity, record.order.id, record.order.assignmentGeneration).then(setCurrent).catch(e => setNotice(e.message)); }}>Porovnať aktuálne údaje</button>{current && <div className="mt-3 overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="p-2 text-left">Údaj</th><th>Server</th><th>Zariadenie</th></tr></thead><tbody>{(['startedAt','finishedAt','destination','driverNotes','performedQuantity','photoException'] as const).map(key => <tr key={key}><td className="p-2">{fieldLabels[key]}</td><td className="p-2">{current.order.fields[key]}</td><td className="p-2">{fields[key]}</td></tr>)}</tbody></table><button className={`${button} mt-2`} onClick={() => void resolveFields()}>Po porovnaní zachovať moje úpravy</button></div>}</div>}
    {notice && <p role="status" className="mt-3 text-sm">{notice}</p>}
  </section>;
}
function localDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0,16); }
