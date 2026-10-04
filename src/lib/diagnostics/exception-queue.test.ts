import { describe, expect, it, vi } from 'vitest';
import { DiagnosticExceptionQueue, EXCEPTION_QUEUE_LIMITS, type DiagnosticExceptionResponse } from './exception-queue';
import { sanitizeDiagnosticException, sanitizeOutboundDiagnosticException } from './sentry';

const origin = 'https://app.test';
function event(index = 1) {
    const error = new TypeError('CANARY_email@example.com +421901123456 CANARY_SECRET');
    error.stack = `CANARY_FUNCTION@${origin}/_next/static/chunks/abcdef1234567890.js?CANARY_SECRET:12:${index}`;
    return sanitizeDiagnosticException(error, index.toString(16).padStart(32, '0'), 'build', origin)!;
}
function fixture() {
    let now = Date.now(), online = false;
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
    const send = vi.fn<(value: unknown) => Promise<DiagnosticExceptionResponse>>(async () => ({ statusCode: 200 }));
    const reserveAttempt = vi.fn(() => true);
    const options = { scope: 'test', sanitize: (value: unknown) => sanitizeOutboundDiagnosticException(value, origin), storage: () => storage, online: () => online, send, reserveAttempt, now: () => now };
    return { queue: new DiagnosticExceptionQueue(options), restore: (scope = 'test') => new DiagnosticExceptionQueue({ ...options, scope }), data, storage, send, reserveAttempt,
        advance: (ms: number) => { now += ms; }, online: () => { online = true; }, saved: () => JSON.parse([...data.values()][0] ?? '{"entries":[]}') };
}
describe('bounded exception delivery', () => {
    it('replays an offline error after a reload with the original release, time and error ID', async () => {
        const f = fixture(), captured = event();
        f.queue.enqueue(captured); await f.queue.flush();
        expect(f.send).not.toHaveBeenCalled();
        expect(JSON.stringify(f.saved())).not.toMatch(/CANARY|example.com|421901|token|FUNCTION/);
        const restored = f.restore(); f.online(); f.advance(120000); await restored.flush();
        expect(f.send).toHaveBeenCalledExactlyOnceWith(captured);
        expect(f.saved().entries).toHaveLength(0);
    });
    it('deduplicates a repeated error before and after acknowledgement and reload', async () => {
        const f = fixture(); f.queue.enqueue(event()); f.queue.enqueue(event());
        expect(f.saved().entries).toHaveLength(1);
        f.online(); await f.queue.flush();
        const again = f.restore(); again.enqueue(event()); await again.flush();
        expect(f.send).toHaveBeenCalledTimes(1);
    });
    it('bounds an offline storm by count and bytes, including persisted metadata', () => {
        const f = fixture();
        for (let i = 1; i <= 1000; i++) f.queue.enqueue(event(i));
        expect(f.saved().entries).toHaveLength(EXCEPTION_QUEUE_LIMITS.events);
        expect(new TextEncoder().encode([...f.data.values()][0]).byteLength).toBeLessThanOrEqual(EXCEPTION_QUEUE_LIMITS.bytes);
        expect(JSON.stringify(f.saved())).not.toContain('CANARY');
    });
    it('expires offline data after 24 hours and refuses another Sentry target', async () => {
        const f = fixture(); f.queue.enqueue(event()); f.advance(EXCEPTION_QUEUE_LIMITS.ttlMs); f.online(); await f.restore().flush();
        expect(f.send).not.toHaveBeenCalled(); expect(f.saved().entries).toHaveLength(0);
        const other = fixture(); other.queue.enqueue(event()); other.online(); await other.restore('different-project').flush();
        expect(other.send).not.toHaveBeenCalled();
    });
    it('preserves the two-attempt minute budget across reloads and shares the collector budget', async () => {
        const f = fixture(); for (let i = 1; i <= 4; i++) f.queue.enqueue(event(i));
        f.online(); await f.queue.flush(); await f.restore().flush();
        expect(f.send).toHaveBeenCalledTimes(2);
        f.advance(60000); f.reserveAttempt.mockReturnValue(false); await f.restore().flush();
        expect(f.send).toHaveBeenCalledTimes(2);
        f.reserveAttempt.mockReturnValue(true); await f.restore().flush();
        expect(f.send).toHaveBeenCalledTimes(4);
    });
    it('retries transient failure at most three times, respecting backoff across reloads', async () => {
        const f = fixture(); f.send.mockResolvedValue({ statusCode: 503 }); f.queue.enqueue(event()); f.online();
        await f.queue.flush(); await f.restore().flush(); expect(f.send).toHaveBeenCalledTimes(1);
        f.advance(60000); await f.restore().flush(); expect(f.send).toHaveBeenCalledTimes(2);
        f.advance(120000); await f.restore().flush(); expect(f.send).toHaveBeenCalledTimes(3);
        f.advance(300000); await f.restore().flush(); expect(f.send).toHaveBeenCalledTimes(3); expect(f.saved().entries).toHaveLength(0);
    });
    it('honors Retry-After and Sentry error rate limits, dropping permanent rejections', async () => {
        const f = fixture(); f.send.mockResolvedValueOnce({ statusCode: 429, headers: { 'retry-after': '120', 'x-sentry-rate-limits': '180:error:organization' } });
        f.queue.enqueue(event()); f.online(); await f.queue.flush(); f.advance(179999); await f.restore().flush(); expect(f.send).toHaveBeenCalledTimes(1);
        f.advance(1); await f.restore().flush(); expect(f.send).toHaveBeenCalledTimes(2);
        f.advance(60000); f.send.mockResolvedValue({ statusCode: 400 }); f.queue.enqueue(event(2)); await f.queue.flush();
        expect(f.saved().entries).toHaveLength(0);
    });
    it('keeps a server cooldown across reloads for every event in the target', async () => {
        const f = fixture(); f.send.mockResolvedValueOnce({ statusCode: 429, headers: { 'retry-after': '180' } });
        f.queue.enqueue(event()); f.queue.enqueue(event(2)); f.online(); await f.queue.flush();
        expect(f.send).toHaveBeenCalledTimes(1);
        const reloaded = f.restore(); reloaded.enqueue(event(3)); f.advance(120000); await reloaded.flush(); expect(f.send).toHaveBeenCalledTimes(1);
        f.advance(60000); await reloaded.flush(); expect(f.send).toHaveBeenCalledTimes(3);
    });
    it('never overlaps requests and ignores late results after logout', async () => {
        const f = fixture(); let finish!: (value: DiagnosticExceptionResponse) => void;
        f.send.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        f.queue.enqueue(event()); f.online(); const pending = f.queue.flush(); await f.queue.flush(); expect(f.send).toHaveBeenCalledTimes(1);
        f.queue.clear(); finish({ statusCode: 503 }); await pending; expect(f.saved().entries).toHaveLength(0);
    });
    it('revalidates persisted events and survives blocked storage without losing memory capture', async () => {
        const f = fixture(); f.queue.enqueue(event());
        const saved = f.saved(); saved.entries[0].event.user = { email: 'CANARY' }; saved.entries[0].event.extra = { message: 'CANARY' }; f.storage.setItem('dispatch-exceptions-v1', JSON.stringify(saved));
        f.online(); await f.restore().flush(); expect(JSON.stringify(f.send.mock.calls)).not.toContain('CANARY');
        const blocked = fixture(); vi.spyOn(blocked.storage, 'getItem').mockImplementation(() => { throw Error('blocked'); }); vi.spyOn(blocked.storage, 'setItem').mockImplementation(() => { throw Error('full'); });
        expect(() => blocked.queue.enqueue(event())).not.toThrow(); blocked.online(); await blocked.queue.flush(); expect(blocked.send).toHaveBeenCalledTimes(1);
    });
});
