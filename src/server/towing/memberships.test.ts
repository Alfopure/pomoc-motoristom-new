import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TowingMember } from '@/domain/towing/types';

const mocks = vi.hoisted(() => ({ from: vi.fn(), getUserById: vi.fn(), createUser: vi.fn(), rpc: vi.fn(), execute: vi.fn() }));
vi.mock('./client', () => ({ towingAdmin: () => ({ from: mocks.from, rpc: mocks.rpc,
  auth: { admin: { getUserById: mocks.getUserById, createUser: mocks.createUser } } }) }));
vi.mock('./service', () => ({ executeTowingCommand: mocks.execute }));
vi.mock('./auth', () => ({ assertTowingEnabled: vi.fn(), actorRpcParams: (actor: TowingMember) => ({
  p_user_id: actor.userId, p_organization_id: actor.organizationId, p_membership_version: actor.version,
}) }));
vi.mock('@/server/rate-limit', () => ({ assertRateLimit: vi.fn(), requestIp: () => 'test' }));
vi.mock('@/server/default-organization', () => ({ resolveDefaultOrganizationId: vi.fn() }));
vi.mock('@/server/email-delivery', () => ({ getEmailConfig: () => ({ enabled: false }),
  buildAppUrl: vi.fn(), escapeHtml: vi.fn(), sendEmailWithOutcome: vi.fn() }));
import { manageTowingMembership } from './memberships';
import { TowingError } from './http';

const actor: TowingMember = { id: '10000000-0000-4000-8000-000000000001', userId: '20000000-0000-4000-8000-000000000001',
  organizationId: '30000000-0000-4000-8000-000000000001', version: 2, active: true,
  displayName: 'Manager', roles: ['manager'], capabilities: ['members'] };
const input = { action: 'invite', membershipId: '40000000-0000-4000-8000-000000000001',
  commandId: '50000000-0000-4000-8000-000000000001', email: 'driver@example.com', displayName: 'Driver', roles: ['driver'] };
type AuthUser = { id: string; email: string; app_metadata: Record<string, unknown> };
let users: Map<string, AuthUser>;
let rows: Record<string, Record<string, unknown> | null>;
const absent = () => ({ data: { user: null }, error: { status: 404, code: 'user_not_found' } });
function storeCreated(attributes: AuthUser) {
  const user = structuredClone({ id: attributes.id, email: attributes.email, app_metadata: attributes.app_metadata });
  users.set(user.id, user); return { data: { user }, error: null };
}
beforeEach(() => {
  vi.resetAllMocks(); users = new Map(); rows = {};
  mocks.from.mockImplementation((table: string) => {
    const query = { select: vi.fn(() => query), eq: vi.fn(() => query), maybeSingle: vi.fn(async () => ({ data: rows[table] ?? null, error: null })) };
    return query;
  });
  mocks.getUserById.mockImplementation(async (id: string) => users.has(id) ? { data: { user: users.get(id) }, error: null } : absent());
  mocks.createUser.mockImplementation(async (attributes: AuthUser) => {
    if (users.has(attributes.id) || [...users.values()].some(user => user.email === attributes.email))
      return { data: { user: null }, error: { status: 422, code: 'email_exists' } };
    return storeCreated(attributes);
  });
  mocks.execute.mockResolvedValue({ commandId: input.commandId, targetId: input.membershipId, revision: 1 });
  mocks.rpc.mockResolvedValue({ data: { shouldSend: false, status: 'pending' }, error: null });
});

describe('recovering a precisely identified towing invitation', () => {
  it('recovers the same account after Auth succeeded but membership failed before commit', async () => {
    mocks.execute.mockRejectedValueOnce(new TowingError('unavailable', 503, 'Database unavailable'));
    await expect(manageTowingMembership(actor, input)).rejects.toMatchObject({ status: 503 });
    expect(users.size).toBe(1); expect(mocks.rpc).not.toHaveBeenCalled();
    const firstCommand = mocks.execute.mock.calls[0][1];
    await manageTowingMembership(actor, input);
    expect(mocks.createUser).toHaveBeenCalledTimes(1);
    expect(mocks.execute.mock.calls[1][1]).toEqual(firstCommand);
    expect(firstCommand.payload.userId).toBe([...users.keys()][0]);
    expect(mocks.rpc).toHaveBeenCalledWith('motorist_towing_access_email_claim', expect.objectContaining({ p_id: input.commandId }));
  });

  it('recovers a committed Auth creation whose response was lost, with one bounded lookup', async () => {
    mocks.createUser.mockImplementationOnce(async (attributes: AuthUser) => { storeCreated(attributes); throw new TypeError('Lost response'); });
    await manageTowingMembership(actor, input);
    expect(users.size).toBe(1); expect(mocks.createUser).toHaveBeenCalledTimes(1);
    expect(mocks.getUserById).toHaveBeenCalledTimes(2);
    expect(mocks.execute.mock.calls[0][1].payload.userId).toBe([...users.keys()][0]);
  });

  it('recovers a concurrent identical creation without changing the winning account', async () => {
    mocks.createUser.mockImplementationOnce(async (attributes: AuthUser) => {
      storeCreated(attributes); return { data: { user: null }, error: { status: 422, code: 'user_already_exists' } };
    });
    await manageTowingMembership(actor, input);
    expect(mocks.createUser).toHaveBeenCalledTimes(1); expect(mocks.getUserById).toHaveBeenCalledTimes(2);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('cannot derive a second account by changing the UUID casing after a membership failure', async () => {
    const original = { ...input, commandId: 'abcdef12-abcd-4abc-8abc-abcdef123456' };
    mocks.execute.mockRejectedValueOnce(new TowingError('unavailable', 503, 'Database unavailable'));
    await expect(manageTowingMembership(actor, original)).rejects.toMatchObject({ status: 503 });
    const originalId = [...users.keys()][0]; mocks.execute.mockClear();
    await expect(manageTowingMembership(actor, { ...original, commandId: original.commandId.toUpperCase() }))
      .rejects.toMatchObject({ code: 'account_unavailable', status: 409 });
    expect(mocks.getUserById.mock.calls.at(-1)?.[0]).toBe(originalId);
    expect(mocks.createUser).toHaveBeenCalledTimes(1); expect(users.size).toBe(1);
    expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    { email: 'other@example.com' }, { roles: ['manager'] }, { displayName: 'Different person' },
    { membershipId: '40000000-0000-4000-8000-000000000002' },
  ])('rejects a changed invite under the same command: %j', async patch => {
    mocks.execute.mockRejectedValueOnce(new TowingError('unavailable', 503, 'Database unavailable'));
    await expect(manageTowingMembership(actor, input)).rejects.toMatchObject({ status: 503 });
    mocks.execute.mockClear();
    await expect(manageTowingMembership(actor, { ...input, ...patch })).rejects.toMatchObject({ code: 'account_unavailable', status: 409 });
    expect(users.size).toBe(1); expect(mocks.createUser).toHaveBeenCalledTimes(1);
    expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(['organizationId','actorId','commandId','membershipId','payloadHash','version'])('rejects a mismatched service-owned provenance field: %s', async key => {
    mocks.execute.mockRejectedValueOnce(new TowingError('unavailable', 503, 'Database unavailable'));
    await expect(manageTowingMembership(actor, input)).rejects.toMatchObject({ status: 503 });
    const user = [...users.values()][0];
    (user.app_metadata.towing_invite as Record<string, unknown>)[key] = 'not-the-original';
    mocks.execute.mockClear();
    await expect(manageTowingMembership(actor, input)).rejects.toMatchObject({ status: 409 });
    expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.createUser).toHaveBeenCalledTimes(1);
  });

  it('does not recover provenance placed only in user-editable metadata', async () => {
    mocks.execute.mockRejectedValueOnce(new TowingError('unavailable', 503, 'Database unavailable'));
    await expect(manageTowingMembership(actor, input)).rejects.toMatchObject({ status: 503 });
    const user = [...users.values()][0]; Object.assign(user, { user_metadata: user.app_metadata }); user.app_metadata = {};
    mocks.execute.mockClear();
    await expect(manageTowingMembership(actor, input)).rejects.toMatchObject({ status: 409 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('does not adopt an arbitrary existing account with the same email or change it', async () => {
    const unrelated = { id: '60000000-0000-4000-8000-000000000001', email: input.email,
      app_metadata: { motorist_module: 'towing', towing_only: true } };
    users.set(unrelated.id, structuredClone(unrelated));
    await expect(manageTowingMembership(actor, input)).rejects.toMatchObject({ code: 'account_unavailable', status: 409 });
    expect([...users.values()]).toEqual([unrelated]); expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    { ...actor, organizationId: '30000000-0000-4000-8000-000000000002' },
    { ...actor, id: '10000000-0000-4000-8000-000000000002' },
  ])('cannot recover another organization or manager invitation', async otherActor => {
    mocks.execute.mockRejectedValueOnce(new TowingError('unavailable', 503, 'Database unavailable'));
    await expect(manageTowingMembership(actor, input)).rejects.toMatchObject({ status: 503 });
    const originalId = [...users.keys()][0]; mocks.execute.mockClear();
    await expect(manageTowingMembership(otherActor, input)).rejects.toMatchObject({ status: 409 });
    expect(mocks.getUserById.mock.calls.at(-1)?.[0]).not.toBe(originalId);
    expect(users.size).toBe(1); expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    { data: { user: null }, error: { status: 503 } },
    { data: { user: null }, error: { status: 401 } },
    { data: { user: null }, error: null },
  ])('does not treat an unavailable or malformed Auth lookup as absence: %j', async result => {
    mocks.getUserById.mockResolvedValueOnce(result);
    await expect(manageTowingMembership(actor, input)).rejects.toMatchObject({ code: 'unavailable', status: 503 });
    expect(mocks.createUser).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('preserves an unknown result when Auth creation and its recovery lookup both lose the network', async () => {
    mocks.createUser.mockRejectedValueOnce(new TypeError('Creation timeout'));
    mocks.getUserById.mockResolvedValueOnce(absent()).mockRejectedValueOnce(new TypeError('Lookup timeout'));
    await expect(manageTowingMembership(actor, input)).rejects.toMatchObject({ code: 'unavailable', status: 503 });
    expect(mocks.createUser).toHaveBeenCalledTimes(1); expect(mocks.getUserById).toHaveBeenCalledTimes(2);
    expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(['motorist_towing_memberships','motorist_profiles'])('retains explicit existing identity reuse through %s', async table => {
    const userId = '70000000-0000-4000-8000-000000000001';
    rows[table] = table === 'motorist_profiles' ? { user_id: userId } : { auth_user_id: userId };
    await manageTowingMembership(actor, input);
    expect(mocks.execute.mock.calls[0][1].payload.userId).toBe(userId);
    expect(mocks.getUserById).not.toHaveBeenCalled(); expect(mocks.createUser).not.toHaveBeenCalled();
  });
});
