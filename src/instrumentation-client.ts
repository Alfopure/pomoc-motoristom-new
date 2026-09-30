import { DIAGNOSTIC_LIMITS } from './lib/diagnostics/types';
import { flushDiagnostics, recordDiagnostic } from './lib/diagnostics/client';
import { captureDiagnosticError } from './lib/diagnostics/errors';
try {
    window.addEventListener('error', (event: Event) => {
        if (event instanceof ErrorEvent) {
            captureDiagnosticError(event.error, 'ui_error');
            return;
        }
        if (!(event.target instanceof HTMLScriptElement)) return;
        try {
            const source = new URL(event.target.src, location.origin);
            if (source.origin === location.origin && source.pathname.startsWith('/_next/static/') && source.pathname.endsWith('.js')) {
                captureDiagnosticError(undefined, 'chunk_error');
            }
        } catch { /* Ignore malformed or unrelated resource URLs. */ }
    }, true);
    window.addEventListener('unhandledrejection', event => { captureDiagnosticError(event.reason, 'unhandled_rejection'); });
    window.addEventListener('offline', () => { recordDiagnostic({ type: 'page_lifecycle', module: 'app', outcome: 'unknown', reason: 'offline' }); });
    window.addEventListener('online', () => { recordDiagnostic({ type: 'page_lifecycle', module: 'app', outcome: 'ok', reason: 'online' }); void flushDiagnostics(); });
    window.addEventListener('pagehide', () => { recordDiagnostic({ type: 'page_lifecycle', module: 'app', outcome: 'unknown', reason: 'pagehide' }); void flushDiagnostics(); });
    window.addEventListener('pageshow', () => { recordDiagnostic({ type: 'page_lifecycle', module: 'app', outcome: 'ok', reason: 'pageshow' }); });
    setInterval(() => { void flushDiagnostics(); }, DIAGNOSTIC_LIMITS.flushMs);
}
catch { /* Fail closed even when browser APIs are unavailable. */ }
