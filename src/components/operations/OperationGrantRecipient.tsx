'use client';
import { useEffect, useRef, useState } from 'react';
import type { PublicOperationCommand, PublicOperationGrant } from '@/domain/operation-grants';
import { Button, Notice } from '@/components/towing/primitives';
import { OperationGrantSummary } from './OperationHandoffPanel';
import styles from './operation-grants.module.css';

type PublicResult = { publication: PublicOperationGrant; commandId?: string; committedRevision?: number; error?: string };
const labels: Record<string, string> = { assigned: 'Pridelené', accepted: 'Prijaté', en_route: 'Na ceste', arrived: 'Na mieste', collected: 'Vozidlo prevzaté', completed: 'Vykonané · dôkazy sa dopĺňajú samostatne', cancelled: 'Jazda zrušená' };
export function OperationGrantRecipient() {
  const [publication, setPublication] = useState<PublicOperationGrant | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [pending, setPending] = useState<PublicOperationCommand | null>(null);
  const started = useRef(false), flight = useRef(false), grantId = useRef<string | null>(null);
  const key = (id: string) => `motorist:public-operation-command:v1:${id}`;
  function accept(body: PublicResult) {
    if (!body.publication?.grantId || !Number.isSafeInteger(body.publication.revision)) throw new Error('Údaje jazdy nie sú úplné. Otvorte pôvodný odkaz.');
    grantId.current = body.publication.grantId;
    setPublication(body.publication);
    history.replaceState(null, '', `/jazda?grant=${encodeURIComponent(body.publication.grantId)}`);
    try {
      const saved = JSON.parse(sessionStorage.getItem(key(body.publication.grantId)) ?? 'null');
      if (saved?.grantId === body.publication.grantId && typeof saved.commandId === 'string' && ['accept', 'start', 'arrive', 'collect', 'complete'].includes(saved.action)) setPending(saved);
    } catch { /* Optional persistence. */ }
  }
  async function read() {
    if (!grantId.current) return;
    const response = await fetch(`/api/public/operation-handoffs/current?grant=${encodeURIComponent(grantId.current)}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    const body = await response.json() as PublicResult;
    if (!response.ok) {
      if ([401, 403, 404, 410].includes(response.status)) setPublication(null);
      throw new Error(body.error ?? 'Jazdu sa nepodarilo načítať.');
    }
    accept(body);
  }
  useEffect(() => {
    if (started.current) return; started.current = true;
    const token = new URLSearchParams(location.hash.slice(1)).get('token');
    grantId.current = new URLSearchParams(location.search).get('grant');
    // A bearer never reaches query strings, subsequent requests or referrers.
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    void (async () => {
      if (token) {
        const response = await fetch('/api/public/operation-handoffs/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(15_000) });
        const body = await response.json() as PublicResult;
        if (!response.ok) throw new Error(body.error ?? 'Odkaz nie je dostupný.');
        accept(body);
      } else if (grantId.current) await read();
      else throw new Error('Otvorte celý odkaz, ktorý vám odovzdala kancelária.');
    })().catch(error => { setPublication(null); setError(error instanceof Error ? error.message : 'Overenie sa nepodarilo. Otvorte pôvodný odkaz.'); }).finally(() => setLoading(false));
  // The initial URL is consumed exactly once; further reads use only the cookie.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!publication) return;
    const check = () => { if (Date.parse(publication.expiresAt) <= Date.now()) { setPublication(null); setError('Platnosť odkazu skončila. Kontaktujte kanceláriu.'); } };
    check(); const timer = window.setInterval(check, 1000); return () => clearInterval(timer);
  }, [publication]);
  async function send(action: PublicOperationCommand['action']) {
    if (!publication || flight.current) return;
    const command = pending ?? { action, commandId: crypto.randomUUID(), grantId: publication.grantId, expectedRevision: publication.revision };
    flight.current = true; setBusy(true); setError(''); setPending(command);
    try { sessionStorage.setItem(key(command.grantId), JSON.stringify(command)); } catch { /* Optional. */ }
    try {
      const response = await fetch('/api/public/operation-handoffs/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command), signal: AbortSignal.timeout(20_000) });
      const body = await response.json() as PublicResult;
      if (!response.ok) {
        if (response.status < 500 && ![408, 429].includes(response.status)) { setPending(null); try { sessionStorage.removeItem(key(command.grantId)); } catch { /* Optional. */ } }
        if ([401, 403, 404, 410].includes(response.status)) setPublication(null);
        throw new Error(body.error ?? 'Výsledok sa nepodarilo potvrdiť.');
      }
      if (body.commandId !== command.commandId || !Number.isSafeInteger(body.committedRevision) || body.publication.grantId !== command.grantId) throw new Error('Potvrdenie nie je úplné. Overte tú istú požiadavku.');
      try { sessionStorage.removeItem(key(command.grantId)); } catch { /* Optional. */ }
      setPending(null); accept(body);
    } catch (error) { setError(error instanceof Error ? error.message : 'Výsledok sa nepodarilo overiť.'); }
    finally { flight.current = false; setBusy(false); }
  }
  const snapshot = publication?.snapshot;
  const next: { action: PublicOperationCommand['action']; label: string } | null = !publication ? null : publication.status === 'assigned' ? { action: 'accept', label: 'Prijať jazdu' } : publication.status === 'accepted' ? { action: 'start', label: 'Začať jazdu' } : publication.status === 'en_route' ? { action: 'arrive', label: 'Som na mieste' } : publication.status === 'arrived' && snapshot?.kind === 'collection' ? { action: 'collect', label: 'Vozidlo prevzaté od klienta' } : ['arrived', 'collected'].includes(publication.status) ? { action: 'complete', label: snapshot?.kind === 'collection' ? 'Vozidlo doručené do cieľa' : 'Potvrdiť odovzdanie a dokončenie' } : null;
  return <main className={styles.publicPage}><article className={styles.publicCard}><header><strong>Pomoc motoristom</strong><h1>Moja pridelená jazda</h1><p>Odkaz patrí iba vodičovi tejto konkrétnej jazdy.</p></header>{loading && <p role="status">Overujem odkaz…</p>}{error && <Notice kind="error">{error}</Notice>}{publication && <><strong>{labels[publication.status] ?? publication.status}</strong>{snapshot && <OperationGrantSummary snapshot={snapshot} />}{!snapshot && <p>Úkon je uzavretý. Kontaktné údaje klienta sa už nezobrazujú.</p>}{next && <div className={styles.actions}><Button primary disabled={busy || !!pending} onClick={() => void send(next.action)}>{next.label}</Button></div>}{pending && <Notice>Predchádzajúci výsledok ešte nie je potvrdený. <Button disabled={busy} onClick={() => void send(pending.action)}>Overiť tú istú požiadavku</Button></Notice>}<Button disabled={busy} onClick={() => { setError(''); void read().catch(error => setError(error.message)); }}>Obnoviť jazdu</Button></>}<footer>Zrušený alebo zmenený prístup sa neobnovuje. Pri probléme kontaktujte kanceláriu; neposielajte odkaz iným osobám.</footer></article></main>;
}
