'use client';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { flushDiagnostics, getDiagnosticReportStatus, reportDiagnosticProblem, subscribeDiagnosticReports } from './client';

const serverStatus = () => 'unavailable' as const;
export function useProblemReport() {
  const [id, setId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const pending = useRef(false);
  const snapshot = useCallback(() => id ? getDiagnosticReportStatus(id) : 'unavailable', [id]);
  const status = useSyncExternalStore(subscribeDiagnosticReports, snapshot, serverStatus);
  useEffect(() => {
    if (status !== 'queued') return;
    const flush = () => { void flushDiagnostics(); };
    // The collector still enforces Retry-After, its backoff and the shared traffic budget.
    const timer = window.setInterval(flush, 5000);
    window.addEventListener('online', flush);
    return () => { window.clearInterval(timer); window.removeEventListener('online', flush); };
  }, [status]);
  const report = async (errorId?: string) => {
    if (pending.current || status === 'queued') return;
    pending.current = true; setSending(true); setId(null);
    try { setId((await reportDiagnosticProblem(errorId)).id); }
    catch { setId(''); }
    finally { pending.current = false; setSending(false); }
  };
  const message = sending ? 'Odosielam hlásenie…'
    : status === 'confirmed' ? 'Hlásenie bolo prijaté.'
    : status === 'queued' ? 'Prijatie zatiaľ nie je potvrdené. Hlásenie čaká na odoslanie; prijatie sa potvrdí automaticky.'
    : status === 'rejected' ? 'Server hlásenie neprijal. Skúste znova alebo kontaktujte správcu.'
    : 'Hlásenie sa nepodarilo odoslať. Skontrolujte prihlásenie a skúste znova.';
  return { id, status, sending, busy: sending || status === 'queued', message, report, attempted: sending || id !== null };
}
