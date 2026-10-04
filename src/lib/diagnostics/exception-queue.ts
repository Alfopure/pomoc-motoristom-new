import type { SafeException } from './sentry';

export const EXCEPTION_QUEUE_LIMITS = {
    events: 8, bytes: 32 * 1024, eventBytes: 8 * 1024,
    ttlMs: 86_400_000, attemptsPerMinute: 2, attemptsPerEvent: 3,
} as const;
const STORAGE_KEY = 'dispatch-exceptions-v1';
export type DiagnosticExceptionResponse = {
    statusCode?: number;
    headers?: { 'retry-after'?: string | null; 'x-sentry-rate-limits'?: string | null };
};
type Entry = { event: SafeException; createdAt: number; attempts: number; nextAt: number };
type Fingerprint = { key: string; at: number };
type Options = {
    scope: string;
    sanitize: (event: unknown) => SafeException | null;
    storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
    online: () => boolean;
    reserveAttempt: (now: number) => boolean;
    send: (event: SafeException) => Promise<DiagnosticExceptionResponse>;
    now?: () => number;
};
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const fingerprint = (event: SafeException) => {
    const exception = event.exception.values[0];
    const top = exception.stacktrace?.frames.at(-1);
    return JSON.stringify([event.release, exception.type, exception.value, top?.filename, top?.lineno, top?.colno]);
};

/** Per-tab sanitized storage, one request at a time, and no independent retry timer. */
export class DiagnosticExceptionQueue {
    private entries: Entry[] = [];
    private attempts: number[] = [];
    private fingerprints: Fingerprint[] = [];
    private nextAttempt = 0;
    private restored = false;
    private running = false;
    private epoch = 0;
    constructor(private readonly options: Options) {}
    private now() { return (this.options.now ?? Date.now)(); }
    private state() { return { scope: this.options.scope, entries: this.entries, attempts: this.attempts, fingerprints: this.fingerprints, nextAttempt: this.nextAttempt }; }
    private prune() {
        const now = this.now();
        this.entries = this.entries.filter(entry => entry.createdAt > now - EXCEPTION_QUEUE_LIMITS.ttlMs && (entry.event.timestamp ?? 0) * 1000 > now - EXCEPTION_QUEUE_LIMITS.ttlMs && entry.attempts < EXCEPTION_QUEUE_LIMITS.attemptsPerEvent);
        this.attempts = this.attempts.filter(at => at > now - 60000 && at <= now);
        this.fingerprints = this.fingerprints.filter(row => row.at > now - 60000 && row.at <= now).slice(-EXCEPTION_QUEUE_LIMITS.events);
        while (this.entries.length > EXCEPTION_QUEUE_LIMITS.events || bytes(this.state()) > EXCEPTION_QUEUE_LIMITS.bytes) this.entries.shift();
    }
    private persist() {
        try {
            this.prune();
            if (this.entries.length || this.attempts.length || this.fingerprints.length || this.nextAttempt > this.now()) this.options.storage().setItem(STORAGE_KEY, JSON.stringify(this.state()));
            else this.options.storage().removeItem(STORAGE_KEY);
        } catch { /* Restricted or full storage falls back to this page's memory. */ }
    }
    private restore() {
        if (this.restored) return;
        this.restored = true;
        try {
            const raw = this.options.storage().getItem(STORAGE_KEY);
            if (!raw || new TextEncoder().encode(raw).byteLength > EXCEPTION_QUEUE_LIMITS.bytes) { this.persist(); return; }
            const saved = JSON.parse(raw);
            if (saved?.scope !== this.options.scope || !Array.isArray(saved.entries)) { this.persist(); return; }
            const now = this.now();
            for (const row of saved.entries.slice(-EXCEPTION_QUEUE_LIMITS.events)) {
                const event = this.options.sanitize(row?.event);
                if (!event || !Number.isFinite(event.timestamp) || !Number.isFinite(row.createdAt) || row.createdAt > now || row.createdAt <= now - EXCEPTION_QUEUE_LIMITS.ttlMs ||
                    !Number.isInteger(row.attempts) || row.attempts < 0 || row.attempts >= EXCEPTION_QUEUE_LIMITS.attemptsPerEvent || !Number.isFinite(row.nextAt) || bytes(event) > EXCEPTION_QUEUE_LIMITS.eventBytes ||
                    this.entries.some(entry => entry.event.event_id === event.event_id)) continue;
                this.entries.push({ event, createdAt: row.createdAt, attempts: row.attempts, nextAt: Math.min(Math.max(row.createdAt, row.nextAt), row.createdAt + EXCEPTION_QUEUE_LIMITS.ttlMs) });
            }
            this.attempts = (Array.isArray(saved.attempts) ? saved.attempts : []).filter((at: unknown) => typeof at === 'number' && Number.isFinite(at) && at > now - 60000 && at <= now).slice(-EXCEPTION_QUEUE_LIMITS.attemptsPerMinute);
            this.nextAttempt = Number.isFinite(saved.nextAttempt) ? Math.min(Math.max(0, saved.nextAttempt), now + EXCEPTION_QUEUE_LIMITS.ttlMs) : 0;
            // ACK history retains only bounded hashes, never arbitrary strings.
            this.fingerprints = (Array.isArray(saved.fingerprints) ? saved.fingerprints : []).filter((row: Fingerprint) =>
                row && typeof row.key === 'string' && /^[a-f0-9]{16}$/.test(row.key) && Number.isFinite(row.at) && row.at > now - 60000 && row.at <= now).slice(-EXCEPTION_QUEUE_LIMITS.events);
        } catch { /* Malformed storage cannot affect the application. */ }
        this.persist();
    }
    private key(event: SafeException): string {
        // Two bounded integer hashes suffice for best-effort storm deduplication;
        // neither this hash nor browser storage is an authorization boundary.
        let first = 0x811c9dc5, second = 0x9e3779b9;
        for (const character of fingerprint(event)) {
            first = Math.imul(first ^ character.charCodeAt(0), 16777619);
            second = Math.imul(second ^ character.charCodeAt(0), 2246822519);
        }
        return (first >>> 0).toString(16).padStart(8, '0') + (second >>> 0).toString(16).padStart(8, '0');
    }
    enqueue(value: unknown): void {
        try {
            this.restore(); this.prune();
            const event = this.options.sanitize(value);
            if (!event || !Number.isFinite(event.timestamp) || bytes(event) > EXCEPTION_QUEUE_LIMITS.eventBytes) return;
            const key = this.key(event);
            if (this.entries.some(entry => entry.event.event_id === event.event_id || this.key(entry.event) === key) || this.fingerprints.some(row => row.key === key)) return;
            const now = this.now();
            this.entries.push({ event, createdAt: now, attempts: 0, nextAt: now });
            this.fingerprints.push({ key, at: now });
            this.persist();
        } catch { /* no-throw */ }
    }
    async flush(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            this.restore(); this.persist();
            while (this.options.online()) {
                const now = this.now();
                this.prune();
                const entry = this.entries.find(row => row.nextAt <= now);
                if (!entry || now < this.nextAttempt || this.attempts.length >= EXCEPTION_QUEUE_LIMITS.attemptsPerMinute || !this.options.reserveAttempt(now)) break;
                const epoch = this.epoch;
                entry.attempts++;
                entry.nextAt = now + 60000 * entry.attempts;
                this.attempts.push(now);
                // Save the attempt before I/O so a reload cannot reset its budget.
                this.persist();
                let response: DiagnosticExceptionResponse = {};
                try { response = await this.options.send(entry.event); } catch { /* bounded retry */ }
                if (epoch !== this.epoch) break;
                const status = response.statusCode;
                const completedAt = this.now();
                const retry = response.headers?.['retry-after'];
                const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - completedAt : 0;
                const limits = response.headers?.['x-sentry-rate-limits']?.split(',').slice(0, 10).map(value => {
                    const [delay, categories] = value.trim().split(':');
                    return (!categories || categories.split(';').includes('error')) && /^\d+(?:\.\d+)?$/.test(delay) ? Number(delay) * 1000 : 0;
                }) ?? [];
                const backoff = Math.min(EXCEPTION_QUEUE_LIMITS.ttlMs, Math.max(60000 * entry.attempts, Number.isFinite(seconds) ? seconds : 0, ...limits));
                if (status === 429 || limits.some(delay => delay > 0)) this.nextAttempt = completedAt + backoff;
                if ((status !== undefined && status >= 200 && status < 300) ||
                    (status !== undefined && status >= 400 && status < 500 && status !== 429) || entry.attempts >= EXCEPTION_QUEUE_LIMITS.attemptsPerEvent) {
                    this.entries = this.entries.filter(row => row !== entry);
                } else {
                    entry.nextAt = completedAt + backoff;
                }
                this.persist();
            }
        } catch { /* Diagnostics cannot escape into a global error handler. */ }
        finally { this.running = false; }
    }
    clear(): void {
        try {
            this.restore(); this.epoch++;
            this.entries = []; this.fingerprints = [];
            // Keep the minute budget across logout or a later login in this tab.
            this.persist();
        } catch { /* no-throw */ }
    }
}
