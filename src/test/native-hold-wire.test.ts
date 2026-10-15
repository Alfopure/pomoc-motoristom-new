import { expect, it, vi } from 'vitest';
import { createTelnyxClient } from '@/server/telephony/telnyx/client';
import { sessionOwnership, type Ownership } from '@/server/telephony/ownership';
import { createFakeSupabase } from './fake-supabase';
import { registerContractTwoRpcs } from './fake-stability';
import { createFakeTelnyx } from './fake-telnyx';
it('fake conference promotion journal matches the actual client wire payload', async () => {
    const fake = createFakeTelnyx();
    const fetch = vi.fn(async () => Response.json({ data: { id: 'conference-real' } }));
    const actual = createTelnyxClient({ config: fake.client.config, liveGate: fake.client.liveGate, fetch });
    const input = { callControlId: 'operator-control', name: 'session-name', commandId: 'stable-id', clientState: 'opaque-state', startConferenceOnCreate: true, beepEnabled: 'never' as const, comfortNoise: false };
    await actual.createConference(input);
    const { db, admin } = createFakeSupabase();
    registerContractTwoRpcs(db);
    const now = Date.now();
    db.seed('motorist_call_sessions', [{ id: 'session', organization_id: 'org', writer_contract: 2, state: 'talking', lease_token: 'owner', lease_generation: 1, lease_until: new Date(now + 15000).toISOString() }]);
    const owner: Ownership = { admin, sessionId: 'session', organizationId: 'org', token: 'owner', generation: 1, contract: 2, acquiredAt: now, deadline: now + 24000 };
    await sessionOwnership.run(owner, () => fake.client.createConference(input));
    const row = db.rows('motorist_provider_commands')[0];
    const call = fetch.mock.calls[0] as unknown as [
        unknown,
        RequestInit
    ];
    expect(row.request_payload).toEqual(JSON.parse(String(call[1].body)));
    expect(row.request_payload).toMatchObject({ call_control_id: 'operator-control', start_conference_on_create: true, comfort_noise: false, command_id: 'stable-id' });
    expect(row.path).toBe('/conferences');
});

it('fake bridge rollback journal matches the actual client wire payload',async()=>{const fake=createFakeTelnyx();const fetch=vi.fn(async()=>Response.json({data:{result:'ok'}}));const actual=createTelnyxClient({config:fake.client.config,liveGate:fake.client.liveGate,fetch});const input={callControlId:'customer',targetCallControlId:'operator',commandId:'bridge-id',parkAfterUnbridge:'self' as const,playRingtone:false};await actual.bridge(input);const {db,admin}=createFakeSupabase();registerContractTwoRpcs(db);const now=Date.now();db.seed('motorist_call_sessions',[{id:'session',organization_id:'org',writer_contract:2,state:'talking',lease_token:'owner',lease_generation:1,lease_until:new Date(now+15000).toISOString()}]);const owner:Ownership={admin,sessionId:'session',organizationId:'org',token:'owner',generation:1,contract:2,acquiredAt:now,deadline:now+24000};await sessionOwnership.run(owner,()=>fake.client.bridge(input));const call=fetch.mock.calls[0] as unknown as [unknown,RequestInit];expect(db.rows('motorist_provider_commands')[0].request_payload).toEqual(JSON.parse(String(call[1].body)));});
