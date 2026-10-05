import { reserveDiagnosticAttempt } from './traffic';
import { diagnosticErrorText } from './error-value';
import { DiagnosticExceptionQueue } from './exception-queue';
import { DIAGNOSTIC_ERROR_CLASSES, isDiagnosticSafeId, isDiagnosticUuid, type DiagnosticErrorClass } from './types';
import { getDiagnosticBreadcrumbs, getDiagnosticUiContext, sanitizeDiagnosticBreadcrumbs, sanitizeDiagnosticUiContext, type DiagnosticBreadcrumb, type DiagnosticUiContext } from './ui-context';
type SafeFrame = {
    filename: string;
    lineno: number;
    colno: number;
    in_app: true;
};
export type SafeException = {
    type: undefined;
    event_id: string;
    level: 'error';
    platform: 'javascript';
    release: string;
    timestamp?: number;
    environment?: 'production' | 'test' | 'development';
    exception: {
        values: {
            type: DiagnosticErrorClass;
            value: string;
            stacktrace?: {
                frames: SafeFrame[];
            };
        }[];
    };
    tags: {
        diagnostic_error_id: string;
        diagnostic_page_id?: string;
        react_error_code?: string;
        browser_family?: 'Safari' | 'Chrome' | 'Firefox' | 'Edge';
        browser_version?: string;
        call_session_id?: string;
        device_session_id?: string;
    };
    contexts?: { dispatch_ui: DiagnosticUiContext };
    breadcrumbs?: DiagnosticBreadcrumb[];
};
export type DiagnosticErrorLocation = { filename: string; lineno: number; colno: number };
export type DiagnosticExceptionContext = { pageId?: string; callSessionId?: string; deviceSessionId?: string; ui?: DiagnosticUiContext; breadcrumbs?: DiagnosticBreadcrumb[]; source?: DiagnosticErrorLocation };
export function diagnosticErrorClass(error: unknown): DiagnosticErrorClass {
    try {
        const name = diagnosticErrorText(error, 'name');
        return DIAGNOSTIC_ERROR_CLASSES.includes(name as DiagnosticErrorClass) ? name as DiagnosticErrorClass : 'UnknownError';
    }
    catch {
        return 'UnknownError';
    }
}
/** React's numeric code is public; its message arguments may contain private data. */
export function diagnosticReactErrorCode(error: unknown): string | undefined {
    try {
        const message = diagnosticErrorText(error, 'message');
        const match = message.match(/^Minified React error #([1-9]\d{0,3});/);
        if (match) return match[1];
        if (message.startsWith('Maximum update depth exceeded.')) return '185';
        if (message.startsWith('Too many re-renders.')) return '301';
    } catch { /* Ignore nonstandard Error accessors. */ }
}
function ownedFrame(filename: string, lineno: number, colno: number, origin: string): SafeFrame | null {
    try {
        if (filename.length > 2048) return null;
        const url = new URL(filename);
        if (url.origin !== origin || url.username || url.password || !/^\/_next\/static\/chunks\/[a-zA-Z0-9][a-zA-Z0-9._~-]{7,127}\.js$/.test(url.pathname) ||
            !Number.isInteger(lineno) || lineno <= 0 || lineno > 1_000_000 || !Number.isInteger(colno) || colno <= 0 || colno > 10_000_000) return null;
        return { filename: `${origin}${url.pathname}`, lineno, colno, in_app: true };
    } catch { return null; }
}
function browserTags(): Pick<SafeException['tags'], 'browser_family' | 'browser_version'> {
    if (typeof navigator === 'undefined') return {};
    const ua = navigator.userAgent.slice(0, 1024);
    for (const [family, pattern] of [
        ['Edge', /Edg(?:e|A|iOS)?\/(\d{1,3}(?:\.\d{1,3}){0,3})/],
        ['Firefox', /(?:Firefox|FxiOS)\/(\d{1,3}(?:\.\d{1,3}){0,3})/],
        ['Chrome', /(?:Chrome|CriOS)\/(\d{1,3}(?:\.\d{1,3}){0,3})/],
        ['Safari', /Version\/(\d{1,3}(?:\.\d{1,3}){0,3}).*Safari\//],
    ] as const) {
        const match = ua.match(pattern);
        if (match) return { browser_family: family, browser_version: match[1] };
    }
    return {};
}
/** Owned compiler coordinates, canonical codes and explicitly bounded technical context only. */
export function sanitizeDiagnosticException(error: unknown, id: string, release: string, origin: string, context: DiagnosticExceptionContext = {}): SafeException | null {
    try {
        if (!/^[a-f0-9]{32}$/.test(id) || !isDiagnosticSafeId(release))
            return null;
        const frames: SafeFrame[] = [];
        const stack = diagnosticErrorText(error, 'stack');
        // Safari starts with a frame; V8 starts with a message that the regex ignores.
        for (const line of stack.split('\n').slice(0, 41)) {
            const match = line.match(/(https?:\/\/[^\s()]+):(\d+):(\d+)\)?$/);
            if (!match)
                continue;
            const frame = ownedFrame(match[1], Number(match[2]), Number(match[3]), origin);
            if (!frame) continue;
            frames.push(frame);
            if (frames.length >= 20)
                break;
        }
        if (!frames.length && context.source) {
            const frame = ownedFrame(context.source.filename, context.source.lineno, context.source.colno, origin);
            if (frame) frames.push(frame);
        }
        const type = diagnosticErrorClass(error);
        const code = diagnosticReactErrorCode(error);
        return sanitizeOutboundDiagnosticException({ event_id: id, level: 'error', platform: 'javascript', release, timestamp: Date.now() / 1000,
            environment: process.env.NEXT_PUBLIC_DIAGNOSTICS_ENVIRONMENT,
            exception: { values: [{ type, value: code ? `React error #${code}` : type, ...(frames.length ? { stacktrace: { frames: frames.reverse() } } : {}) }] },
            tags: { diagnostic_error_id: id, diagnostic_page_id: context.pageId, react_error_code: code, ...browserTags(), call_session_id: context.callSessionId, device_session_id: context.deviceSessionId },
            contexts: { dispatch_ui: context.ui ?? getDiagnosticUiContext() }, breadcrumbs: context.breadcrumbs ?? getDiagnosticBreadcrumbs(),
        }, origin);
    }
    catch {
        return null;
    }
}
/** Revalidate after the SDK prepares the event; SDK scopes never expand this schema. */
export function sanitizeOutboundDiagnosticException(value: unknown, origin: string): SafeException | null {
    try {
        const input = value as SafeException;
        if (!input || !/^[a-f0-9]{32}$/.test(input.event_id) || !isDiagnosticSafeId(input.release)) return null;
        const exception = input.exception?.values?.[0];
        if (!exception || !DIAGNOSTIC_ERROR_CLASSES.includes(exception.type)) return null;
        const frames = (Array.isArray(exception.stacktrace?.frames) ? exception.stacktrace.frames : []).slice(-20).flatMap(frame => {
            if (!frame || typeof frame.filename !== 'string') return [];
            const url = new URL(frame.filename);
            if (url.search || url.hash) return [];
            const safe = ownedFrame(frame.filename, frame.lineno, frame.colno, origin);
            return safe ? [safe] : [];
        });
        const code = typeof exception.value === 'string' ? exception.value.match(/^React error #([1-9]\d{0,3})$/)?.[1] : undefined;
        const tags: SafeException['tags'] = { diagnostic_error_id: input.event_id };
        if (code) tags.react_error_code = code;
        if (isDiagnosticUuid(input.tags?.diagnostic_page_id)) tags.diagnostic_page_id = input.tags.diagnostic_page_id;
        if (isDiagnosticUuid(input.tags?.call_session_id)) tags.call_session_id = input.tags.call_session_id;
        if (isDiagnosticUuid(input.tags?.device_session_id)) tags.device_session_id = input.tags.device_session_id;
        if (['Safari', 'Chrome', 'Firefox', 'Edge'].includes(input.tags?.browser_family ?? '')) tags.browser_family = input.tags.browser_family;
        if (tags.browser_family && typeof input.tags.browser_version === 'string' && /^\d{1,3}(?:\.\d{1,3}){0,3}$/.test(input.tags.browser_version)) tags.browser_version = input.tags.browser_version;
        return { type: undefined, event_id: input.event_id, level: 'error', platform: 'javascript', release: input.release,
            ...(typeof input.timestamp === 'number' && Number.isFinite(input.timestamp) && input.timestamp > 0 && input.timestamp <= Date.now() / 1000 + 60 ? { timestamp: input.timestamp } : {}),
            ...(['production', 'test', 'development'].includes(input.environment ?? '') ? { environment: input.environment } : {}),
            exception: { values: [{ type: exception.type, value: code ? `React error #${code}` : exception.type, ...(frames.length ? { stacktrace: { frames } } : {}) }] }, tags,
            contexts: { dispatch_ui: sanitizeDiagnosticUiContext(input.contexts?.dispatch_ui) }, breadcrumbs: sanitizeDiagnosticBreadcrumbs(input.breadcrumbs),
        };
    } catch { return null; }
}
let clientPromise: Promise<import('@sentry/browser').BrowserClient> | undefined;
let queue: DiagnosticExceptionQueue | undefined;
function exceptionQueue(): DiagnosticExceptionQueue | undefined {
    const dsn = process.env.NEXT_PUBLIC_DIAGNOSTICS_SENTRY_DSN;
    if (!dsn || typeof location === 'undefined' || typeof navigator === 'undefined') return;
    return queue ??= new DiagnosticExceptionQueue({
        scope: `${process.env.NEXT_PUBLIC_DIAGNOSTICS_ENVIRONMENT ?? ''}:${new URL(dsn).host}${new URL(dsn).pathname}`,
        online: () => navigator.onLine,
        storage: () => sessionStorage,
        sanitize: event => {
            const safe = sanitizeOutboundDiagnosticException(event, location.origin);
            return safe?.environment === process.env.NEXT_PUBLIC_DIAGNOSTICS_ENVIRONMENT ? safe : null;
        },
        reserveAttempt: reserveDiagnosticAttempt,
        send: async event => {
            const sdk = await import('./sentry-sdk');
            clientPromise ??= Promise.resolve(sdk.createPrivateSentryClient(dsn));
            try { return await sdk.sendPrivateSentryEvent(await clientPromise, event); }
            catch { clientPromise = undefined; return {}; }
        },
    });
}
/** Explicit errors-only client with only our closed-schema breadcrumbs. */
export function sendDiagnosticException(error: unknown, id: string, context?: DiagnosticExceptionContext): void {
    try {
        const pending = exceptionQueue();
        if (!pending) return;
        const event = sanitizeDiagnosticException(error, id, process.env.NEXT_PUBLIC_DIAGNOSTICS_BUILD_ID || 'local', location.origin, context);
        if (event) pending.enqueue(event);
        void pending.flush();
    }
    catch { /* Diagnostics must never recurse into the global error handler. */ }
}
export async function flushDiagnosticExceptions(): Promise<void> {
    try { await exceptionQueue()?.flush(); } catch { /* no-throw */ }
}
export function clearDiagnosticExceptions(): void {
    try { exceptionQueue()?.clear(); } catch { /* no-throw */ }
}
