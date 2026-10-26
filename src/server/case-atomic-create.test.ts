import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';
import { caseCreationIdentity, commitAtomicCaseCreation } from './case-atomic-create';

const commandId = 'a0000000-0000-4000-8000-000000000001';
describe('atomic web case creation', () => {
  it('keeps the same content identity across editor presence renewal and includes independent origin', () => {
    const input = { creationCommandId: commandId, contactName: 'Client', partnerOrigin: { partnerId: 'partner', sourceLineId: 'line' } };
    const identity = caseCreationIdentity(input);
    expect(identity?.mutationId).toBe(commandId);
    expect(caseCreationIdentity({ ...input, editorSessionId: 'another-session' } as typeof input)).toEqual(identity);
    expect(caseCreationIdentity({ ...input, partnerOrigin: { partnerId: 'other', sourceLineId: 'line' } })).not.toEqual(identity);
    expect(caseCreationIdentity({ contactName: 'Legacy mobile' })).toBeUndefined();
    expect(() => caseCreationIdentity({ partnerOrigin: { partnerId: 'partner' } })).toThrow();
  });
  it('sends related rows, origin, history and one stable receipt identity through one write boundary', async () => {
    const rpc = vi.fn(async () => ({ data: { id: commandId, case_number: 'PM-2026-0001' }, error: null }));
    const input = { organizationId: 'org', actorId: 'profile', identity: caseCreationIdentity({ creationCommandId: commandId })!,
      casePatch: { owner_id: 'profile' }, related: [], eventBody: 'Created', eventPayload: { source: 'manual_dispatch_form' },
      partnerOrigin: { partnerId: 'partner', sourceCallId: 'call' } };
    const result = await commitAtomicCaseCreation({ rpc } as unknown as SupabaseClient<Database>, input);
    expect(result.id).toBe(commandId);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('motorist_create_case_atomic', expect.objectContaining({
      p_organization_id: 'org', p_actor_id: 'profile', p_command_id: commandId,
      p_fingerprint: input.identity.fingerprint, p_partner_origin: input.partnerOrigin,
      p_related: [], p_event_body: 'Created',
    }));
  });
  it.each([['PT422', 422], ['42501', 403], ['22023', 400], ['08006', 503]])('keeps SQL %s out of a fallback insert', async (code, status) => {
    const rpc = vi.fn(async () => ({ data: null, error: { code } }));
    await expect(commitAtomicCaseCreation({ rpc } as unknown as SupabaseClient<Database>, {
      organizationId: 'org', actorId: 'profile', identity: { mutationId: commandId, fingerprint: 'a'.repeat(64) },
      casePatch: {}, related: [], eventBody: '', eventPayload: {},
    })).rejects.toMatchObject({ status });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
