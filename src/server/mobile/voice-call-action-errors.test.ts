import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallActionError } from '@/server/telephony/service-errors';

const m = vi.hoisted(() => ({ transfer: vi.fn(), lease: vi.fn(), session: vi.fn() }));
vi.mock('@/server/telephony/call-actions', () => ({ blindTransfer: m.transfer, listTransferTargets: vi.fn(), stopCallRecording: vi.fn() }));
vi.mock('./voice', () => ({ requireNativeLease: m.lease, requireNativeSession: m.session }));
const { transferNativeCall } = await import('./voice-call-actions');
const actor = { userId: 'u', profileId: '11111111-1111-4111-8111-111111111111', organizationId: 'o', displayName: 'D', role: 'dispatcher' as const };
const input = { deviceSessionId: '22222222-2222-4222-8222-222222222222', profileId: '33333333-3333-4333-8333-333333333333' };
beforeEach(() => { vi.resetAllMocks(); m.session.mockResolvedValue({ direction: 'inbound', nativeConnected: true, nativeEnded: false }); });

describe('native transfer errors', () => {
  it("never shows a colleague's personal number", async () => {
    m.transfer.mockRejectedValue(new CallActionError('Číslo kolegu +421905123456 nie je povolené (allowlist).', 403, 'destination_not_allowed'));
    const error = await transferNativeCall({} as never, actor, 'session', input).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 409, code: 'target_unavailable' });
    expect(String((error as Error).message)).not.toMatch(/\d{6}/);
  });
  it('passes other refusals through unchanged', async () => {
    m.transfer.mockRejectedValue(new CallActionError('Kolega nie je dostupný.', 409, 'target_unavailable'));
    await expect(transferNativeCall({} as never, actor, 'session', input)).rejects.toMatchObject({ message: 'Kolega nie je dostupný.' });
  });
});
