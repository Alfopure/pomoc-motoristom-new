import type { SafeException } from './sentry';
import { EXCEPTION_DELIVERY_REASONS } from './types';
export type ExceptionDeliveryReason = typeof EXCEPTION_DELIVERY_REASONS[number];
export type ExceptionDeliveryCounters = Partial<Record<ExceptionDeliveryReason, number>>;

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
/** Per-tab sanitized storage, one request at a time, and no independent retry timer. */
export class DiagnosticExceptionQueue {
    private entries: Entry[] = [];
    private attempts: number[] = [];
    private fingerprints: Fingerprint[] = [];
    private nextAttempt = 0;
    private restored = false;
    private running = false;
    private epoch = 0;
    private counters: ExceptionDeliveryCounters = {};
    private storageFailed = false;
    constructor(private readonly options: Options) {}
    private now() { return (this.options.now ?? Date.now)(); }
    private count(reason: ExceptionDeliveryReason, count = 1) { this.counters[reason] = Math.min(2_147_483_647, (this.counters[reason] ?? 0) + count); }
    private state() { return { counters: this.counters, scope: this.options.scope, entries: this.entries, attempts: this.attempts, fingerprints: this.fingerprints, nextAttempt: this.nextAttempt }; }
    private prune() {
        const now = this.now();
        this.entries = this.entries.filter(entry => {
            if (entry.createdAt <= now - EXCEPTION_QUEUE_LIMITS.ttlMs || (entry.event.timestamp ?? 0) * 1000 <= now - EXCEPTION_QUEUE_LIMITS.ttlMs) { this.count('sentry_expired'); return false; }
            return true;
        });
        this.attempts = this.attempts.filter(at => at > now - 60000 && at <= now);
        this.fingerprints = this.fingerprints.filter(row => row.at > now - 60000 && row.at <= now).slice(-EXCEPTION_QUEUE_LIMITS.events);
        while (this.entries.length && (this.entries.length > EXCEPTION_QUEUE_LIMITS.events || bytes(this.state()) > EXCEPTION_QUEUE_LIMITS.bytes)) { this.entries.shift(); this.count('sentry_overflow'); }
    }
    private persist() {
        try {
            this.prune();
            if (Object.values(this.counters).some(Boolean) || this.entries.length || this.attempts.length || this.fingerprints.length || this.nextAttempt > this.now()) this.options.storage().setItem(STORAGE_KEY, JSON.stringify(this.state()));
            else this.options.storage().removeItem(STORAGE_KEY);
            this.storageFailed = false;
        } catch {
            // Count a storage failure episode, not every retry while storage is blocked.
            if (!this.storageFailed) this.count('sentry_storage_unavailable');
            this.storageFailed = true;
        }
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
            for (const reason of EXCEPTION_DELIVERY_REASONS) {
                const count = saved.counters?.[reason];
                if (Number.isInteger(count) && count > 0 && count <= 2_147_483_647) this.counters[reason] = count;
            }
            for (const row of saved.entries.slice(-EXCEPTION_QUEUE_LIMITS.events)) {
                const event = this.options.sanitize(row?.event);
                if (!event || !Number.isFinite(event.timestamp) || !Number.isFinite(row.createdAt) || row.createdAt > now ||
                    !Number.isInteger(row.attempts) || row.attempts < 0 || row.attempts > EXCEPTION_QUEUE_LIMITS.attemptsPerEvent || !Number.isFinite(row.nextAt) || bytes(event) > EXCEPTION_QUEUE_LIMITS.eventBytes ||
                    this.entries.some(entry => entry.event.event_id === event.event_id)) { this.count('sentry_invalid'); continue; }
                if (row.attempts === EXCEPTION_QUEUE_LIMITS.attemptsPerEvent) { this.count('sentry_retry_exhausted'); continue; }
                this.entries.push({ event: { ...event, tags: { ...event.tags, restored_from_storage: 'true' } }, createdAt: row.createdAt, attempts: row.attempts, nextAt: Math.min(Math.max(row.createdAt, row.nextAt), row.createdAt + EXCEPTION_QUEUE_LIMITS.ttlMs) });
            }
            this.attempts = (Array.isArray(saved.attempts) ? saved.attempts : []).filter((at: unknown) => typeof at === 'number' && Number.isFinite(at) && at > now - 60000 && at <= now).slice(-EXCEPTION_QUEUE_LIMITS.attemptsPerMinute);
            this.nextAttempt = Number.isFinite(saved.nextAttempt) ? Math.min(Math.max(0, saved.nextAttempt), now + EXCEPTION_QUEUE_LIMITS.ttlMs) : 0;
            // ACK history retains only bounded hashes, never arbitrary strings.
            this.fingerprints = (Array.isArray(saved.fingerprints) ? saved.fingerprints : []).filter((row: Fingerprint) =>
                row && typeof row.key === 'string' && /^[a-f0-9]{32}$/.test(row.key) && Number.isFinite(row.at) && row.at > now - 60000 && row.at <= now).slice(-EXCEPTION_QUEUE_LIMITS.events);
        } catch { /* Malformed storage cannot affect the application. */ }
        this.persist();
    }
    enqueue(value: unknown): 'enqueued' | 'deduplicated' | 'invalid' {
        try {
            this.restore(); this.prune();
            const event = this.options.sanitize(value);
            if (!event || !Number.isFinite(event.timestamp) || bytes(event) > EXCEPTION_QUEUE_LIMITS.eventBytes) { this.count('sentry_invalid'); this.persist(); return 'invalid'; }
            // Identity is assigned once by captureDiagnosticError with call/page scope.
            // A second stack-based dedupe here used to orphan displayed error IDs.
            const key = event.event_id;
            if (this.entries.some(entry => entry.event.event_id === key) || this.fingerprints.some(row => row.key === key)) { this.count('sentry_deduplicated'); this.persist(); return 'deduplicated'; }
            const now = this.now();
            this.entries.push({ event: { ...event, tags: { ...event.tags, captured_offline: this.options.online() ? 'false' : 'true' } }, createdAt: now, attempts: 0, nextAt: now });
            this.fingerprints.push({ key, at: now });
            this.count('sentry_enqueued');
            this.persist();
            return 'enqueued';
        } catch { this.count('sentry_invalid'); return 'invalid'; }
    }
    /** Deltas are handed to the existing persisted collector, never mistaken for its dropped count. */
    reportCounters(report: (reason: ExceptionDeliveryReason, count: number) => boolean): void {
        try {
            this.restore(); this.prune();
            for (const reason of EXCEPTION_DELIVERY_REASONS) {
                const count = Math.min(10000, this.counters[reason] ?? 0);
                if (count && report(reason, count)) this.counters[reason] = Math.max(0, (this.counters[reason] ?? 0) - count);
            }
            this.persist();
        } catch { /* Collector failures retain the counter for a later opportunity. */ }
    }
    snapshot(): { pending: number; counters: ExceptionDeliveryCounters } {
        this.restore(); this.prune();
        return { pending: this.entries.length, counters: { ...this.counters } };
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
                try { response = await this.options.send({ ...entry.event, tags: { ...entry.event.tags, delivery_attempt: String(entry.attempts), delivery_delay_ms: String(Math.min(EXCEPTION_QUEUE_LIMITS.ttlMs, Math.max(0, Math.round(now - (entry.event.timestamp ?? now / 1000) * 1000)))) } }); } catch { /* bounded retry */ }
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
                    this.count(status !== undefined && status >= 200 && status < 300 ? 'sentry_delivered' : status !== undefined && status >= 400 && status < 500 && status !== 429 ? 'sentry_rejected' : 'sentry_retry_exhausted');
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
            if (this.entries.length) this.count('sentry_cleared', this.entries.length);
            this.entries = []; this.fingerprints = [];
            // Keep the minute budget across logout or a later login in this tab.
            this.persist();
        } catch { /* no-throw */ }
    }
}
