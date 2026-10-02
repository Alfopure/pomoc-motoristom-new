'use client';
import { useEffect, useRef } from 'react';
import { captureDiagnosticError } from './errors';
import { useProblemReport } from './useProblemReport';
export function ErrorFallback({ error, retry, scope = 'app' }: {
    error: Error;
    retry: () => void;
    scope?: 'app' | 'case';
}) {
    const result = useProblemReport();
    const errorId = useRef<string | null>(null);
    useEffect(() => { errorId.current = captureDiagnosticError(error, 'ui_error', true); }, [error]);
    const Container = scope === 'case' ? 'section' : 'main';
    return <Container style={{ maxWidth: 640, margin: scope === 'case' ? '1rem auto' : '10vh auto', padding: 24, fontFamily: 'system-ui', color: '#172033' }}>
    {scope === 'case' ? <h2>Prípad sa nepodarilo zobraziť</h2> : <h1>Obrazovku sa nepodarilo zobraziť</h1>}
    <p>{scope === 'case' ? 'Obnoví sa iba editor prípadu. Neuložené zmeny sa po obnovení nemusia zachovať.' : 'Ak práve telefonujete, najprv overte stav hovoru. Obnovenie obrazovky môže prerušiť spojenie.'}</p>
    <button type="button" onClick={retry}>{scope === 'case' ? 'Obnoviť editor' : 'Skúsiť znova'}</button>{' '}
    <button type="button" disabled={result.busy} onClick={() => { void result.report(errorId.current ?? undefined); }}>{result.sending ? 'Odosielam…' : result.status === 'queued' ? 'Čaká na prijatie…' : 'Nahlásiť problém'}</button>
    <p role="status">{result.attempted ? result.message : ''}{result.id ? ` ID: ${result.id}` : ''}</p>
  </Container>;
}
