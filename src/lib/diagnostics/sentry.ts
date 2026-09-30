import { reserveDiagnosticAttempt } from './traffic';
import { DIAGNOSTIC_ERROR_CLASSES, isDiagnosticSafeId, type DiagnosticErrorClass } from './types';
type SafeFrame = {
    filename: string;
    lineno: number;
    colno: number;
    in_app: true;
};
export type SafeException = {
    event_id: string;
    level: 'error';
    platform: 'javascript';
    release: string;
    exception: {
        values: {
            type: DiagnosticErrorClass;
            value: string;
            stacktrace: {
                frames: SafeFrame[];
            };
        }[];
    };
    tags: {
        diagnostic_error_id: string;
    };
};
export function diagnosticErrorClass(error: unknown): DiagnosticErrorClass {
    try {
        const name = error instanceof Error ? error.name : '';
        return DIAGNOSTIC_ERROR_CLASSES.includes(name as DiagnosticErrorClass) ? name as DiagnosticErrorClass : 'UnknownError';
    }
    catch {
        return 'UnknownError';
    }
}
/** Only application compiler chunk locations survive; no message/function/context/request/user data. */
export function sanitizeDiagnosticException(error: unknown, id: string, release: string, origin: string): SafeException | null {
    try {
        if (!/^[a-f0-9]{32}$/.test(id) || !isDiagnosticSafeId(release))
            return null;
        const frames: SafeFrame[] = [];
        const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack.slice(0, 16384) : '';
        for (const line of stack.split('\n').slice(1, 41)) {
            const match = line.match(/(https?:\/\/[^\s()]+):(\d+):(\d+)\)?$/);
            if (!match)
                continue;
            const url = new URL(match[1]);
            if (url.origin !== origin || !/^\/_next\/static\/chunks\/[a-zA-Z0-9][a-zA-Z0-9._~-]{7,127}\.js$/.test(url.pathname))
                continue;
            frames.push({ filename: `${origin}${url.pathname}`, lineno: Math.min(Number(match[2]), 1000000), colno: Math.min(Number(match[3]), 10000000), in_app: true });
            if (frames.length >= 20)
                break;
        }
        const type = diagnosticErrorClass(error);
        return { event_id: id, level: 'error', platform: 'javascript', release, exception: { values: [{ type, value: type, stacktrace: { frames: frames.reverse() } }] }, tags: { diagnostic_error_id: id } };
    }
    catch {
        return null;
    }
}
let pending = 0;
let sent: number[] = [];
let clientPromise: Promise<import('@sentry/browser').BrowserClient> | undefined;
const fingerprints = new Map<string, number>();
/** Explicit errors-only client: no integrations, scopes, sessions, tracing, replay or breadcrumbs. */
export function sendDiagnosticException(error: unknown, id: string): void {
    try {
        const dsn = process.env.NEXT_PUBLIC_DIAGNOSTICS_SENTRY_DSN;
        if (!dsn || typeof location === 'undefined' || !navigator.onLine || pending >= 2)
            return;
        const event = sanitizeDiagnosticException(error, id, process.env.NEXT_PUBLIC_DIAGNOSTICS_BUILD_ID || 'local', location.origin);
        if (!event)
            return;
        const now = Date.now();
        sent = sent.filter(t => t > now - 60000);
        const fingerprint = JSON.stringify(event.exception);
        for (const [key, time] of fingerprints)
            if (time < now - 60000)
                fingerprints.delete(key);
        if (sent.length >= 2 || fingerprints.has(fingerprint) || !reserveDiagnosticAttempt(now))
            return;
        fingerprints.set(fingerprint, now);
        sent.push(now);
        pending++;
        clientPromise ??= import('./sentry-sdk').then(({ createPrivateSentryClient }) => createPrivateSentryClient(dsn));
        void clientPromise.then(client => { client.captureEvent(event); }).catch(() => { clientPromise = undefined; }).finally(() => { pending--; });
    }
    catch { /* Diagnostics must never recurse into the global error handler. */ }
}
