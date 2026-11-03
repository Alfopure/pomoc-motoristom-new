'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Operation } from '@/domain/operations';
import type { OperationGrantCommand, OperationGrantContext, OperationGrantReceipt, OperationGrantSnapshot } from '@/domain/operation-grants';
import { Button, Field, Notice, Select } from '@/components/towing/primitives';
import styles from './operation-grants.module.css';

const date = (value: string | null) => value ? new Intl.DateTimeFormat('sk-SK', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Bratislava' }).format(new Date(value)) : 'Bez termínu';
export function OperationGrantSummary({ snapshot }: { snapshot: OperationGrantSnapshot }) {
  return <dl className={styles.summary}><div><dt>Jazda pre</dt><dd>{snapshot.recipientName}</dd></div><div><dt>Úkon</dt><dd>{({ delivery: 'Pristavenie', collection: 'Odvoz vozidla', transfer: 'Presun' })[snapshot.kind]}</dd></div>{snapshot.caseNumber && <div><dt>Prípad</dt><dd>{snapshot.caseNumber}</dd></div>}<div><dt>Vozidlo</dt><dd>{snapshot.vehicle ?? 'Neuvedené'}</dd></div><div><dt>Odkiaľ</dt><dd>{snapshot.from}</dd></div><div><dt>Kam</dt><dd>{snapshot.to}</dd></div><div><dt>Termín</dt><dd>{date(snapshot.scheduledAt)} · Bratislava</dd></div>{snapshot.customer && <div><dt>Kontakt na klienta</dt><dd>{snapshot.customer.name} {snapshot.customer.phone}</dd></div>}</dl>;
}
export function OperationHandoffPanel({ operation, actorKey }: { operation: Operation; actorKey: string }) {
  const [context, setContext] = useState<OperationGrantContext | null>(null), [error, setError] = useState(''), [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [pending, setPending] = useState<OperationGrantCommand | null>(null), [open, setOpen] = useState(false);
  const flight = useRef(false);
  const key = `motorist:operation-grant:v1:${actorKey}:${operation.id}`;
  const load = useCallback(async () => {
    const response = await fetch(`/api/operations/${operation.id}/handoffs`, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? 'Odkazy sa nepodarilo načítať.');
    return body as OperationGrantContext;
  }, [operation.id]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    void load().then(data => {
      if (!active) return;
      setContext(data);
      try {
        const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
        if (value && ['issue', 'revoke', 'recover'].includes(value.action) && typeof value.commandId === 'string' && Number.isSafeInteger(value.expectedRevision)) setPending(value);
      } catch { /* Persistence is optional. */ }
    }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [open, load, key, operation.revision]);
  async function run(command: OperationGrantCommand) {
    if (flight.current) return;
    flight.current = true; setBusy(true); setError(''); setPending(command); setUrl('');
    try { sessionStorage.setItem(key, JSON.stringify(command)); } catch { /* Optional. */ }
    try {
      const response = await fetch(`/api/operations/${operation.id}/handoffs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(20_000) });
      const body = await response.json() as OperationGrantReceipt & { error?: string };
      if (!response.ok) {
        if (response.status < 500 && ![408, 429].includes(response.status)) { setPending(null); try { sessionStorage.removeItem(key); } catch { /* Optional. */ } }
        throw new Error(body.error ?? 'Výsledok odkazu sa nepodarilo potvrdiť.');
      }
      if (body.commandId !== command.commandId || !body.grant?.id || !Number.isSafeInteger(body.committedRevision)) throw new Error('Potvrdenie nie je úplné. Overte tú istú požiadavku.');
      setPending(null); try { sessionStorage.removeItem(key); } catch { /* Optional. */ }
      setUrl(body.url ?? ''); setContext(await load());
    } catch (error) { setError(error instanceof Error ? error.message : 'Výsledok sa nepodarilo overiť.'); }
    finally { flight.current = false; setBusy(false); }
  }
  const active = context?.grants.find(grant => grant.status === 'active');
  const terminal = ['completed', 'cancelled'].includes(operation.status);
  return <section className={styles.panel} aria-label="Odkaz na konkrétnu jazdu"><div className={styles.heading}><h3>Odkaz pre prideleného vodiča</h3><Button onClick={() => setOpen(!open)}>{open ? 'Zavrieť odkazy' : 'Otvoriť odkazy'}</Button></div>{open && <>
    <p>Príjemcom je pridelený vodič {operation.assignee ?? '— najprv prideľte jazdu'}. Odkaz sprístupní iba jeho konkrétnu jazdu. Telefón ani email sa automaticky neodosiela.</p>
    {error && <Notice kind="error">{error}</Notice>}
    {pending && <Notice>Výsledok ešte nie je potvrdený. <Button disabled={busy} onClick={() => void run(pending)}>Overiť tú istú požiadavku</Button></Notice>}
    {context?.preview && <OperationGrantSummary snapshot={context.preview} />}
    {context && !active && !terminal && context.preview && <form className={styles.form} onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); if (!context.previewVersion) return; void run({ action: 'issue', commandId: crypto.randomUUID(), expectedRevision: context.operationRevision, previewVersion: context.previewVersion, hours: Number(data.get('hours')) }); }}><Select label="Platnosť odkazu" name="hours" defaultValue="24"><option value="4">4 hodiny</option><option value="24">24 hodín</option><option value="72">72 hodín</option></Select><label className={styles.confirm}><input type="checkbox" required disabled={busy || !!pending} /> Potvrdzujem tento náhľad pre {context.preview.recipientName}.</label><Button primary type="submit" disabled={busy || !!pending}>Vytvoriť odkaz na túto jazdu</Button></form>}
    {active && context && <><p>Aktívny odkaz pre {active.recipientName} · do {date(active.expiresAt)}.</p><Button disabled={busy || !!pending || terminal} onClick={() => void run({ action: 'recover', commandId: crypto.randomUUID(), expectedRevision: context.operationRevision, grantId: active.id })}>Zobraziť existujúci odkaz</Button><form className={styles.form} onSubmit={event => { event.preventDefault(); void run({ action: 'revoke', commandId: crypto.randomUUID(), expectedRevision: context.operationRevision, grantId: active.id, reason: String(new FormData(event.currentTarget).get('reason') ?? '') }); }}><Field label="Dôvod zrušenia prístupu" name="reason" required maxLength={1000} /><Button danger type="submit" disabled={busy || !!pending}>Zrušiť iba odkaz</Button></form><p>Zrušenie odkazu nezruší jazdu ani návrat auta. Zmenené údaje zverejnite zrušením starého a vytvorením nového odkazu.</p></>}
    {url && <div className={styles.link}><Field label="Odkaz pre prideleného vodiča – neposielajte iným osobám" readOnly value={url} onFocus={event => event.currentTarget.select()} /><Button onClick={() => { void navigator.clipboard.writeText(url).catch(() => setError('Odkaz označte a skopírujte ručne.')); }}>Skopírovať odkaz</Button></div>}
    {!!context?.grants.length && <details><summary>História odkazov ({context.grants.length})</summary>{context.grants.map(grant => <p key={grant.id}>{grant.recipientName} · {({ active: 'Aktívny', revoked: 'Zrušený', expired: 'Platnosť skončila', assignment_changed: 'Zmenené pridelenie', outdated: 'Údaje alebo prístup sa zmenili' })[grant.status]} · {date(grant.createdAt)}</p>)}</details>}
  </>}</section>;
}
