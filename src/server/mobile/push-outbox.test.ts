import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: vi.fn() }));
import { outboxOutcomes, type OutboxRow } from './push-outbox';
const row = (id: string): OutboxRow => ({ id, leaseId: 'l-' + id, memberId: 'm', profileId: null, type: 'work', event: 'work_assigned', title: 't', body: 'b', target: { kind: 'operation', id: 'o' } });
describe('work push outbox outcomes', () => {
  it('counts a row sent when any of its phones was reached', () => {
    expect(outboxOutcomes([row('a')], [{ rowId: 'a' }, { rowId: 'a' }], ['failed', 'sent'])).toEqual([{ id: 'a', lease_id: 'l-a', outcome: 'sent' }]);
  });
  it('drops a row without a wanting phone or whose phones were all removed', () => {
    expect(outboxOutcomes([row('a'), row('b')], [{ rowId: 'b' }], ['gone'])).toEqual([{ id: 'a', lease_id: 'l-a', outcome: 'no_device' }, { id: 'b', lease_id: 'l-b', outcome: 'no_device' }]);
  });
  it('retries a row only when every reachable attempt failed', () => {
    expect(outboxOutcomes([row('a')], [{ rowId: 'a' }, { rowId: 'a' }], ['failed', 'gone'])).toEqual([{ id: 'a', lease_id: 'l-a', outcome: 'failed' }]);
  });
});

import { afterEach, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { drainPushOutbox } from './push-outbox';
const ORG = '20000000-0000-4000-8000-000000000001', USER = '10000000-0000-4000-8000-000000000001', TASK = '30000000-0000-4000-8000-000000000001';
const MEMBER = '40000000-0000-4000-8000-000000000001';
function drainFixture(preferences: Record<string, boolean> = {}) {
  const entry: OutboxRow = { id: 'notice', leaseId: 'lease', memberId: MEMBER, profileId: null, userId: USER, type: 'tasks', event: 'task_assigned', title: 'Nová úloha', body: 'Máte pridelenú úlohu.', target: { kind: 'employee-task', id: TASK } };
  const devices = [{ id: 'phone', member_id: MEMBER, profile_id: null, expo_push_token: 'ExponentPushToken[abcdefghijkl]', preferences }];
  const chain = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), gte: vi.fn(), limit: vi.fn(), abortSignal: vi.fn(async () => ({ data: devices, error: null })) };
  for (const method of ['select', 'eq', 'in', 'gte', 'limit'] as const) chain[method].mockReturnValue(chain);
  const rpc = vi.fn((name: string) => ({ abortSignal: vi.fn(async () => ({ data: name === 'motorist_push_outbox_claim' ? [entry] : 1, error: null })) }));
  const admin = { from: vi.fn(() => chain), rpc } as unknown as SupabaseClient;
  const transport = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ data: [{ status: 'ok' }] }), { status: 200 }));
  return { admin, rpc, entry, transport };
}
beforeEach(() => vi.stubEnv('MOBILE_PUSH_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());
describe('canonical employee task pushes through existing outbox', () => {
  it('sends a field employee task with canonical user identity and no legacy profile owner', async () => {
    const f = drainFixture();
    expect(await drainPushOutbox(f.admin, ORG, { transport: f.transport })).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
    const options = f.transport.mock.calls[0][1] as RequestInit;
    const sent = JSON.parse(String(options.body));
    expect(sent[0].data).toEqual({ kind: 'employee-task', id: TASK, userId: USER });
    expect(f.rpc).toHaveBeenLastCalledWith('motorist_push_outbox_finish', { p_organization_id: ORG, p_results: [{ id: 'notice', lease_id: 'lease', outcome: 'sent' }] });
  });
  it('respects the task preference of a field phone', async () => {
    const f = drainFixture({ tasks: false });
    expect(await drainPushOutbox(f.admin, ORG, { transport: f.transport })).toMatchObject({ noDevice: 1, sent: 0 });
    expect(f.transport).not.toHaveBeenCalled();
  });
  it('does not send a canonical target without a verified recipient user id', async () => {
    const f = drainFixture(); f.entry.userId = null;
    expect(await drainPushOutbox(f.admin, ORG, { transport: f.transport })).toMatchObject({ noDevice: 1, sent: 0 });
    expect(f.transport).not.toHaveBeenCalled();
  });
  it('leaves rows retryable when no send started before the deadline', async () => {
    const f = drainFixture();
    expect(await drainPushOutbox(f.admin, ORG, { transport: f.transport, deadline: Date.now() - 1 })).toMatchObject({ failed: 1, sent: 0 });
    expect(f.transport).not.toHaveBeenCalled();
  });
});
