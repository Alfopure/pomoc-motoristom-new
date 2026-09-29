'use client';
import { useEffect, useState } from 'react';
import { captureDiagnosticError } from './errors';
import { reportDiagnosticProblem } from './client';
export function ErrorFallback({ error, retry }: {
    error: Error;
    retry: () => void;
}) {
    const [status, setStatus] = useState('');
    const [sending, setSending] = useState(false);
    useEffect(() => { captureDiagnosticError(error, 'ui_error', true); }, [error]);
    async function report() {
        setSending(true);
        try {
            const result = await reportDiagnosticProblem();
            setStatus(result.confirmed ? `Hlásenie bolo prijaté. ID: ${result.id}` : 'Prijatie hlásenia sa nepodarilo potvrdiť. Kontaktujte správcu.');
        }
        finally {
            setSending(false);
        }
    }
    return <main style={{ maxWidth: 640, margin: '10vh auto', padding: 24, fontFamily: 'system-ui', color: '#172033' }}>
    <h1>Obrazovku sa nepodarilo zobraziť</h1>
    <p>Ak práve telefonujete, najprv overte stav hovoru. Obnovenie obrazovky môže prerušiť spojenie.</p>
    <button type="button" onClick={retry}>Skúsiť znova</button>{' '}
    <button type="button" disabled={sending} onClick={() => { void report(); }}>Nahlásiť problém</button>
    <p role="status">{status}</p>
  </main>;
}
