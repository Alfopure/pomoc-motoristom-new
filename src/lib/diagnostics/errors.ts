import { getDiagnosticCallContext } from './context';
import { getDiagnosticPageId, recordDiagnostic } from './client';
import { getDiagnosticBreadcrumbs, getDiagnosticUiContext } from './ui-context';
import { diagnosticErrorClass, sanitizeDiagnosticException, sendDiagnosticException, type DiagnosticErrorLocation } from './sentry';
import { diagnosticErrorText } from './error-value';
const seen = new WeakMap<object, string>();
const recent = new Map<string, {
    id: string;
    at: number;
}>();
export function captureDiagnosticError(error: unknown, type: 'ui_error' | 'chunk_error' | 'unhandled_rejection' = 'ui_error', boundary = false, source?: DiagnosticErrorLocation): string | null {
    try {
        if (error && typeof error === 'object' && seen.has(error))
            return seen.get(error)!;
        const context = getDiagnosticCallContext();
        const ui = getDiagnosticUiContext();
        const exceptionContext = { ...context, pageId: getDiagnosticPageId(), ui, breadcrumbs: getDiagnosticBreadcrumbs(), source };
        let id = crypto.randomUUID().replaceAll('-', '');
        const safe = sanitizeDiagnosticException(error, id, process.env.NEXT_PUBLIC_DIAGNOSTICS_BUILD_ID || 'local', typeof location === 'undefined' ? '' : location.origin, exceptionContext);
        const top = safe?.exception.values[0].stacktrace?.frames.at(-1);
        const fingerprint = JSON.stringify([diagnosticErrorClass(error), safe?.tags.react_error_code, top?.filename, top?.lineno, top?.colno, type, ui.case_id, context.callSessionId, context.deviceSessionId]);
        const prior = recent.get(fingerprint);
        if (prior && Date.now() - prior.at < 30000)
            id = prior.id;
        else
            recent.set(fingerprint, { id, at: Date.now() });
        while (recent.size > 20)
            recent.delete(recent.keys().next().value!);
        if (error && typeof error === 'object')
            seen.set(error, id);
        const errorClass = diagnosticErrorClass(error);
        const chunkFailure = errorClass === 'ChunkLoadError' || /Loading chunk .+ failed|Failed to fetch dynamically imported module|Importing a module script failed/i.test(diagnosticErrorText(error, 'message'));
        const eventType = chunkFailure ? 'chunk_error' : type;
        recordDiagnostic({ ...context, ...(ui.case_id ? { caseId: ui.case_id } : {}), type: eventType, module: 'app', outcome: 'failed', errorClass, errorId: id, reason: boundary ? 'boundary' : eventType === 'chunk_error' ? 'chunk_load' : eventType === 'unhandled_rejection' ? 'global_rejection' : 'global_error' });
        sendDiagnosticException(error, id, exceptionContext);
        return id;
    }
    catch {
        return null;
    }
}
