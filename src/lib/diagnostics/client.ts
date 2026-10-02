import { DIAGNOSTIC_LIMITS, isDiagnosticUuid, parseDiagnosticEvent, type DiagnosticEvent, type DiagnosticEventInput, type DiagnosticModule, type DiagnosticOperation } from './types';
import { setDiagnosticCallContext } from './context';
import { getDiagnosticCallContext } from './context';
import { addDiagnosticBreadcrumb, getDiagnosticUiContext, resetDiagnosticUiContext } from './ui-context';
import { reserveDiagnosticAttempt } from './traffic';
import { createDiagnosticPersistence, type DiagnosticIdentity, type DiagnosticPersistence } from './persistence';
export { setDiagnosticCallContext, retainDiagnosticCallContext } from './context';

const QUEUE_PAYLOAD_BYTES = 107 * 1024; // Preserve the stricter payload budget below the 128 KiB ceiling.
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const actorKey = (actor: DiagnosticIdentity | null) => actor ? `${actor.organizationId}:${actor.profileId}` : '';
const uuid = () => crypto.randomUUID();
export type DiagnosticCoverage = {
    queued: number;
    bytes: number;
    dropped: number;
    deduplicated: number;
    acknowledged: number;
    degraded: boolean;
};
export type DiagnosticReportStatus = 'queued' | 'confirmed' | 'rejected' | 'unavailable';
type Options = {
    pageId: string;
    buildId: string;
    persistence: DiagnosticPersistence;
    now?: () => number;
    monotonic?: () => number;
    random?: () => number;
    online?: () => boolean;
    fetch?: typeof fetch;
    reserveAttempt?: () => boolean;
};
/** All public entry points fail closed; diagnostic failure never escapes into business code. */
export class DiagnosticCollector {
    private events: DiagnosticEvent[] = [];
    private queueBytes = 2;
    private actor: DiagnosticIdentity | null = null;
    private generation = 0;
    private sequence = 0;
    private attempts: number[] = [];
    private nextAttempt = 0;
    private failures = 0;
    private inFlight = false;
    private flightIds = new Set<string>();
    private confirmed = new Set<string>();
    private rejected = new Set<string>();
    private listeners = new Set<() => void>();
    private dropped = 0;
    private reportedDropped = 0;
    private deduplicated = 0;
    private degraded = false;
    private persistPending = false;
    private persistRunning = false;
    private lastCritical = -Infinity;
    private restored: Promise<void> = Promise.resolve();
    constructor(private readonly options: Options) { }
    private now() { return (this.options.now ?? Date.now)(); }
    private mono() { return (this.options.monotonic ?? (() => performance.now()))(); }
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private notify() { for (const listener of this.listeners) { try { listener(); } catch { /* A subscriber cannot affect ingestion. */ } } }
    private prune() {
        const before = this.events.length;
        this.events = this.events.filter(e => Date.parse(e.occurredAt) > this.now() - DIAGNOSTIC_LIMITS.ttlMs);
        if (before !== this.events.length)
            this.queueBytes = bytes(this.events);
        this.dropped += before - this.events.length;
        if (before !== this.events.length) this.notify();
    }
    private persist() {
        this.persistPending = true;
        if (this.persistRunning)
            return;
        this.persistRunning = true;
        // Persistence is asynchronous and coalesced, never serialized on an action's path.
        queueMicrotask(() => {
            void (async () => {
                try {
                    await this.restored;
                    while (this.persistPending) {
                        this.persistPending = false;
                        await this.options.persistence.write(this.actor ? { actor: { ...this.actor }, events: this.events.map(e => ({ ...e })) } : null);
                    }
                }
                catch {
                    this.degraded = true;
                }
                finally {
                    this.persistRunning = false;
                }
            })();
        });
    }
    setIdentity(actor: DiagnosticIdentity | null): void {
        try {
            if (actor && (!isDiagnosticUuid(actor.profileId) || !isDiagnosticUuid(actor.organizationId)))
                actor = null;
            if (actor && actorKey(actor) === actorKey(this.actor))
                return;
            setDiagnosticCallContext(null);
            const initial = this.generation === 0;
            if (!initial || !actor) resetDiagnosticUiContext();
            const generation = ++this.generation;
            this.events = [];
            this.queueBytes = 2;
            this.confirmed.clear();
            this.rejected.clear();
            this.dropped = 0;
            this.reportedDropped = 0;
            this.deduplicated = 0;
            this.actor = actor ? { ...actor } : null;
            this.nextAttempt = 0;
            this.failures = 0;
            this.notify();
            if (!actor || !initial) {
                this.persist();
                return;
            }
            this.restored = (async () => {
                try {
                    const saved = await this.options.persistence.read();
                    if (generation !== this.generation)
                        return;
                    if (saved && actorKey(saved.actor) === actorKey(this.actor)) {
                        const current = this.events;
                        this.events = [];
                        this.queueBytes = 2;
                        for (const raw of [...saved.events.slice(-DIAGNOSTIC_LIMITS.queueEvents), ...current]) {
                            const event = parseDiagnosticEvent(raw);
                            if (event && !this.events.some(e => e.id === event.id)) {
                                this.sequence = Math.max(this.sequence, event.sequence);
                                this.insert(event);
                            }
                        }
                    }
                    this.prune();
                    this.notify();
                    this.persist();
                }
                catch {
                    this.degraded = true;
                }
            })();
        }
        catch {
            this.degraded = true;
        }
    }
    private insert(event: DiagnosticEvent) {
        this.prune();
        // Keep in-flight payload immutable: an ACK must not consume unseen repetitions.
        const fingerprint = (e: DiagnosticEvent) => [e.type, e.module, e.operation, e.outcome, e.reason, e.errorClass, e.errorId, e.caseId, e.callSessionId, e.deviceSessionId].join(':');
        if (!event.sampled && event.type !== 'user_report' && event.type !== 'operation' && event.type !== 'coverage') {
            const duplicate = this.events.find(e => !this.flightIds.has(e.id) && fingerprint(e) === fingerprint(event) && this.now() - Date.parse(e.occurredAt) < 30000);
            if (duplicate) {
                const previousBytes = bytes(duplicate);
                const totalCount = (duplicate.count ?? 1) + (event.count ?? 1);
                this.dropped += Math.max(0, totalCount - DIAGNOSTIC_LIMITS.maxCount);
                duplicate.count = Math.min(DIAGNOSTIC_LIMITS.maxCount, totalCount);
                this.queueBytes += bytes(duplicate) - previousBytes;
                this.deduplicated++;
                return duplicate.id;
            }
        }
        this.queueBytes += bytes(event) + (this.events.length ? 1 : 0);
        this.events.push(event);
        while (this.events.length > DIAGNOSTIC_LIMITS.queueEvents || this.queueBytes > QUEUE_PAYLOAD_BYTES) {
            const removed = this.events.shift()!;
            this.queueBytes -= bytes(removed) + (this.events.length ? 1 : 0);
            this.dropped++;
            this.degraded = true;
        }
        return event.id;
    }
    record(input: DiagnosticEventInput): string | null {
        try {
            if (!this.actor)
                return null;
            const event = parseDiagnosticEvent({ ...input, id: uuid(), pageId: this.options.pageId, sequence: ++this.sequence, occurredAt: new Date(this.now()).toISOString(), monotonicMs: Math.max(0, this.mono()), buildId: this.options.buildId, sampled: input.sampled ?? false, sampleRate: input.sampleRate ?? 1 });
            if (!event) {
                this.dropped++;
                return null;
            }
            const id = this.insert(event) ?? null;
            this.notify();
            this.persist();
            if ((input.type.endsWith('error') || input.outcome === 'failed') && this.now() - this.lastCritical >= DIAGNOSTIC_LIMITS.criticalFlushMs) {
                this.lastCritical = this.now();
                void this.flush();
            }
            return id;
        }
        catch {
            this.degraded = true;
            return null;
        }
    }
    async flush(): Promise<void> {
        try {
            await this.restored;
            this.prune();
            if (!this.actor || this.inFlight || (!this.events.length && this.dropped <= this.reportedDropped) || !(this.options.online?.() ?? true) || this.now() < this.nextAttempt)
                return;
            this.attempts = this.attempts.filter(t => t > this.now() - 60000);
            if (this.attempts.length >= DIAGNOSTIC_LIMITS.attemptsPerMinute)
                return;
            if (this.dropped > this.reportedDropped && !this.events.some(e => e.type === 'coverage' && e.pageId === this.options.pageId)) {
                const coverageId = this.record({ type: 'coverage', module: 'app', outcome: 'unknown', reason: 'queue_drop', count: Math.min(DIAGNOSTIC_LIMITS.maxCount, this.dropped - this.reportedDropped) });
                const index = this.events.findIndex(e => e.id === coverageId);
                if (index > 0)
                    this.events.unshift(...this.events.splice(index, 1));
            }
            const actor = { ...this.actor };
            const generation = this.generation;
            const events: DiagnosticEvent[] = [];
            for (const event of this.events) {
                if (events.length >= DIAGNOSTIC_LIMITS.batchEvents || bytes({ actor, events: [...events, event] }) > DIAGNOSTIC_LIMITS.batchBytes)
                    break;
                events.push({ ...event });
            }
            if (!events.length || !(this.options.reserveAttempt?.() ?? true))
                return;
            this.inFlight = true;
            this.flightIds = new Set(events.map(e => e.id));
            this.attempts.push(this.now());
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            try {
                const response = await (this.options.fetch ?? fetch)('/api/diagnostics/events', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actor, events }), signal: controller.signal, keepalive: true });
                if (generation !== this.generation)
                    return;
                if (response.status === 401 || response.status === 403) {
                    this.setIdentity(null);
                    this.degraded = true;
                    return;
                }
                if (!response.ok) {
                    const header = response.headers.get('Retry-After');
                    const delay = header ? (/^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - this.now()) : 0;
                    this.retry(Number.isFinite(delay) ? Math.max(0, delay) : 0);
                    return;
                }
                const ack = await response.json() as {
                    acceptedIds?: unknown;
                    rejectedIds?: unknown;
                    degraded?: boolean;
                };
                if (generation !== this.generation)
                    return;
                const accepted = new Set(Array.isArray(ack.acceptedIds) ? ack.acceptedIds.filter(id => typeof id === 'string' && this.flightIds.has(id)) : []);
                const rejected = new Set(Array.isArray(ack.rejectedIds) ? ack.rejectedIds.filter(id => typeof id === 'string' && this.flightIds.has(id) && !accepted.has(id)) : []);
                for (const id of accepted) {
                    this.confirmed.add(id);
                    const event = events.find(e => e.id === id);
                    if (event?.type === 'coverage' && event.pageId === this.options.pageId)
                        this.reportedDropped += event.count ?? 0;
                }
                while (this.confirmed.size > DIAGNOSTIC_LIMITS.queueEvents)
                    this.confirmed.delete(this.confirmed.values().next().value!);
                for (const id of rejected) this.rejected.add(id);
                while (this.rejected.size > DIAGNOSTIC_LIMITS.queueEvents) this.rejected.delete(this.rejected.values().next().value!);
                this.events = this.events.filter(e => !accepted.has(e.id) && !rejected.has(e.id));
                this.queueBytes = bytes(this.events);
                this.dropped += rejected.size;
                this.degraded ||= !!ack.degraded || rejected.size > 0;
                if (accepted.size || rejected.size) {
                    this.failures = 0;
                    this.nextAttempt = this.now() + DIAGNOSTIC_LIMITS.criticalFlushMs;
                }
                else
                    this.retry();
                this.persist();
                this.notify();
            }
            catch {
                if (generation === this.generation)
                    this.retry();
            }
            finally {
                clearTimeout(timeout);
                this.inFlight = false;
                this.flightIds.clear();
            }
        }
        catch {
            this.degraded = true;
        }
    }
    private retry(minimum = 0) { this.degraded = true; this.nextAttempt = this.now() + Math.max(minimum, [5000, 15000, 60000, 300000][Math.min(this.failures++, 3)] * (1 + (this.options.random?.() ?? Math.random()) * .2)); }
    identityEpoch() { return this.generation; }
    pageId() { return this.options.pageId; }
    isConfirmed(id: string) { return this.confirmed.has(id); }
    reportStatus(id: string): DiagnosticReportStatus {
        if (this.confirmed.has(id)) return 'confirmed';
        if (this.rejected.has(id)) return 'rejected';
        return this.events.some(e => e.id === id && e.type === 'user_report') ? 'queued' : 'unavailable';
    }
    coverage(): DiagnosticCoverage { return { queued: this.events.length, bytes: this.queueBytes, dropped: this.dropped, deduplicated: this.deduplicated, acknowledged: this.confirmed.size, degraded: this.degraded }; }
}
let collector: DiagnosticCollector | undefined;
function instance() {
    if (!collector) {
        const pageId = uuid();
        let storageId = uuid();
        try {
            const saved = sessionStorage.getItem('diagnostic-tab');
            if (saved && isDiagnosticUuid(saved))
                storageId = saved;
            else
                sessionStorage.setItem('diagnostic-tab', storageId);
        }
        catch { /* memory-only identity */ }
        collector = new DiagnosticCollector({ pageId, buildId: process.env.NEXT_PUBLIC_DIAGNOSTICS_BUILD_ID || 'local', persistence: createDiagnosticPersistence(storageId), reserveAttempt: reserveDiagnosticAttempt, online: () => typeof navigator === 'undefined' || navigator.onLine });
    }
    return collector;
}
export function recordDiagnostic(input: DiagnosticEventInput): string | null { try {
    return instance().record(input);
}
catch {
    return null;
} }
export function setDiagnosticIdentity(actor: DiagnosticIdentity | null): void {
    try {
        instance().setIdentity(actor);
        if (!actor) {
            try {
                sessionStorage.removeItem("diagnostic-tab");
            }
            catch { /* restricted storage */ }
        }
    }
    catch { /* no-throw */ }
}
export async function flushDiagnostics(): Promise<void> { try {
    await instance().flush();
}
catch { /* no-throw */ } }
export function getDiagnosticCoverage(): DiagnosticCoverage { try {
    return instance().coverage();
}
catch {
    return { queued: 0, bytes: 0, dropped: 0, deduplicated: 0, acknowledged: 0, degraded: true };
} }
export function getDiagnosticPageId(): string | undefined { try { return instance().pageId(); } catch { return; } }
export function getDiagnosticReportStatus(id: string): DiagnosticReportStatus { try { return id ? instance().reportStatus(id) : 'unavailable'; } catch { return 'unavailable'; } }
export function subscribeDiagnosticReports(listener: () => void): () => void { try { return instance().subscribe(listener); } catch { return () => {}; } }
export async function reportDiagnosticProblem(errorId?: string): Promise<{
    id: string;
    confirmed: boolean;
}> {
    const ui = getDiagnosticUiContext();
    const id = recordDiagnostic({ ...getDiagnosticCallContext(), ...(ui.case_id ? { caseId: ui.case_id } : {}), ...(errorId ? { errorId } : {}), type: 'user_report', module: 'app', outcome: 'unknown', reason: 'user_requested' }) ?? '';
    await flushDiagnostics();
    return { id, confirmed: !!id && (collector?.isConfirmed(id) ?? false) };
}
export function beginDiagnosticOperation(operation: DiagnosticOperation, module: DiagnosticModule = 'app', context: Partial<DiagnosticEventInput> = {}) {
    let start = 0;
    let sampled = false;
    let operationId: string | undefined;
    let epoch = -1;
    try {
        start = performance.now();
        sampled = Math.random() < DIAGNOSTIC_LIMITS.sampleRate;
        operationId = isDiagnosticUuid(context.operationId) ? context.operationId : uuid();
        epoch = instance().identityEpoch();
        addDiagnosticBreadcrumb({ timestamp: Date.now() / 1000, category: 'diagnostic.operation', type: 'default', level: 'info', data: { module, operation, phase: 'start', case_id: context.caseId } });
    }
    catch { /* no-throw */ }
    let completed = false;
    return (result: Partial<DiagnosticEventInput> & Pick<DiagnosticEventInput, 'outcome'>) => {
        try {
            if (completed)
                return;
            completed = true;
            if (instance().identityEpoch() !== epoch)
                return;
            const durationMs = Math.max(0, result.durationMs ?? performance.now() - start);
            addDiagnosticBreadcrumb({ timestamp: Date.now() / 1000, category: 'diagnostic.operation', type: 'default', level: 'info', data: { module, operation, phase: 'finish', outcome: result.outcome, case_id: result.caseId ?? context.caseId, duration_ms: durationMs } });
            if (sampled || !['ok', 'cancelled', 'conflict'].includes(result.outcome) || durationMs >= 3000)
                recordDiagnostic({ ...context, ...result, type: 'operation', module, operation, operationId, durationMs, sampled, sampleRate: DIAGNOSTIC_LIMITS.sampleRate });
        }
        catch { /* no-throw */ }
    };
}
