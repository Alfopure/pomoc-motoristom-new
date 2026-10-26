import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), actor: vi.fn(), jar: { get: vi.fn(), set: vi.fn() } }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => mocks.jar }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => ({ rpc: mocks.rpc }) }));
vi.mock('./index', () => ({ requireOperationsActor: mocks.actor }));
vi.mock('@/server/rate-limit', () => ({ assertRateLimit: vi.fn(), requestIp: () => '127.0.0.1' }));
import { commandOperationGrant, getOperationGrantContext, parseGrantCommand, parsePublicOperationCommand, publicOperationGrant } from './grants';
const id = '11111111-1111-4111-8111-111111111111';
const operation = '22222222-2222-4222-8222-222222222222';
const grant = '33333333-3333-4333-8333-333333333333';
const command = { action: 'issue', commandId: id, expectedRevision: 3, hours: 24, previewVersion: 'a'.repeat(64) };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.mockResolvedValue({ userId: id, organizationId: id, canDispatch: true });
  mocks.jar.get.mockReturnValue({ value: 'a'.repeat(43) });
});
describe('operation-only web publication boundary', () => {
  it('accepts a stable explicit issue intent without recipient override', () => expect(parseGrantCommand(command)).toEqual(command));
  it.each([{ recipientPhone: '+421900000000' }, { recipientMemberId: id }, { operationId: id }, { hours: 100 }, { previewVersion: 'old' }])('rejects recipient/scope overrides and stale-shaped preview %j', extra => {
    expect(() => parseGrantCommand({ ...command, ...extra })).toThrow();
  });
  it('requires a reason to revoke access', () => {
    expect(() => parseGrantCommand({ action: 'revoke', commandId: id, expectedRevision: 3, grantId: grant, reason: ' ' })).toThrow();
  });
  it.each(['create', 'assign', 'return', 'inspect', 'evidence', 'cancel', 'confirm'])('does not expose office command %s through public links', action => {
    expect(() => parsePublicOperationCommand({ action, commandId: id, grantId: grant, expectedRevision: 3 })).toThrow();
  });
  it('uses the separate scoped server RPC for context', async () => {
    mocks.rpc.mockResolvedValue({ data: { preview: null, grants: [] }, error: null });
    await getOperationGrantContext(operation);
    expect(mocks.rpc).toHaveBeenCalledWith('motorist_operation_grant', expect.objectContaining({ p_operation_id: operation, p_user_id: id, p_action: 'context' }));
  });
  it('rejects a cross-origin write before resolving privileged auth or RPC', async () => {
    await expect(commandOperationGrant(new Request('https://example.test/api', { method: 'POST', headers: { Origin: 'https://other.test', 'Content-Type': 'application/json' }, body: JSON.stringify(command) }), operation)).rejects.toMatchObject({ status: 403 });
    expect(mocks.actor).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('exchanges only a hashed bearer and sets a scoped httpOnly session', async () => {
    mocks.rpc.mockResolvedValue({ data: { publication: { grantId: grant, revision: 3 }, sessionExpiresAt: '2030-01-01T00:00:00Z' }, error: null });
    const result = await publicOperationGrant(new Request('https://example.test/api/public/operation-handoffs/session', { method: 'POST', headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'a'.repeat(43) }) }), 'session');
    expect(mocks.rpc).toHaveBeenCalledWith('motorist_public_operation_grant', expect.objectContaining({ p_action: 'session', p_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(mocks.jar.set).toHaveBeenCalledWith('pm_operation_grant', expect.any(String), expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'strict', path: '/api/public/operation-handoffs' }));
    expect(result).not.toHaveProperty('sessionExpiresAt');
  });
  it('checks a grant ID against the cookie on every private read', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'P0002' } });
    await expect(publicOperationGrant(new Request(`https://example.test/api/public/operation-handoffs/current?grant=${grant}`), 'read')).rejects.toMatchObject({ status: 404 });
    expect(mocks.rpc).toHaveBeenCalledWith('motorist_public_operation_grant', expect.objectContaining({ p_input: { grantId: grant } }));
  });
});
