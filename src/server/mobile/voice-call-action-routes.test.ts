import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as transfer } from '@/app/api/mobile/v1/voice/calls/[id]/transfer/route';
import { POST as targets } from '@/app/api/mobile/v1/voice/calls/[id]/transfer-targets/route';
import { POST as recording } from '@/app/api/mobile/v1/voice/calls/[id]/recording/route';
import { MutationError } from '@/server/mutation-error';

const m = vi.hoisted(() => ({ actor: vi.fn(), deps: vi.fn(), transfer: vi.fn(), targets: vi.fn(), stop: vi.fn() }));
vi.mock('./auth', () => ({ requireMobileActor: m.actor, mobileEnvironment: () => 'test' }));
vi.mock('./voice', () => ({ nativeVoiceDeps: m.deps }));
vi.mock('./voice-call-actions', () => ({ transferNativeCall: m.transfer, listNativeTransferTargets: m.targets, stopNativeRecording: m.stop }));
const actor = { profileId: 'operator', organizationId: 'org', role: 'dispatcher' };
const id = '33333333-3333-4333-8333-333333333333';
const context = { params: Promise.resolve({ id }) };
const body = { deviceSessionId: '11111111-1111-4111-8111-111111111111', profileId: '22222222-2222-4222-8222-222222222222' };
const post = (text = JSON.stringify(body)) => new Request('https://test.dispecing.linkapomoci.sk/api/mobile/v1/voice/calls/id/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
beforeEach(() => {
  vi.resetAllMocks(); m.actor.mockResolvedValue(actor); m.deps.mockResolvedValue({ mock: true });
  m.transfer.mockResolvedValue({ sessionId: id, state: 'transferring' }); m.targets.mockResolvedValue({ targets: [] }); m.stop.mockResolvedValue({ sessionId: id, recording: { state: 'stopped', suppressed: true } });
});

describe('native transfer and recording routes', () => {
  it('authenticate before reading anything', async () => {
    m.actor.mockRejectedValue(new MutationError('denied', 401));
    for (const response of [await transfer(post('{'), context), await recording(post('{'), context), await targets(post('{'), context)]) {
      expect(response.status).toBe(401); expect(response.headers.get('cache-control')).toContain('no-store');
    }
    expect(m.deps).not.toHaveBeenCalled();
  });
  it('reject malformed JSON before the services', async () => {
    expect((await transfer(post('{'), context)).status).toBe(400);
    expect((await recording(post('{'), context)).status).toBe(400);
    expect(m.transfer).not.toHaveBeenCalled(); expect(m.stop).not.toHaveBeenCalled();
  });
  it('pass the exact session and body to the services', async () => {
    expect(await (await transfer(post(), context)).json()).toMatchObject({ sessionId: id, state: 'transferring' });
    expect(m.transfer).toHaveBeenCalledWith({ mock: true }, actor, id, body);
    await recording(post(JSON.stringify({ deviceSessionId: body.deviceSessionId })), context);
    expect(m.stop).toHaveBeenCalledWith({ mock: true }, actor, id, { deviceSessionId: body.deviceSessionId });
    await targets(post(JSON.stringify({ deviceSessionId: body.deviceSessionId })), context);
    expect(m.targets).toHaveBeenCalledWith({ mock: true }, actor, id, { deviceSessionId: body.deviceSessionId });
  });
  it('lets a caller objection stop recording while mobile calling is being switched off', async () => {
    await recording(post(JSON.stringify({ deviceSessionId: body.deviceSessionId })), context);
    expect(m.deps).toHaveBeenLastCalledWith(actor, { cleanup: true });
    await transfer(post(), context);
    expect(m.deps).toHaveBeenLastCalledWith(actor);
  });
  it('hide unexpected errors behind a plain message', async () => {
    m.transfer.mockRejectedValue(new Error('provider secret')); m.stop.mockRejectedValue(new Error('provider secret'));
    for (const response of [await transfer(post(), context), await recording(post(), context)]) {
      expect(JSON.stringify(await response.json())).not.toContain('secret');
    }
    expect((await (await recording(post(), context)).json()).error).toBe('Zastavenie nahrávania nie je potvrdené. Volajúcemu zatiaľ nehovorte, že sa nenahráva.');
  });
});
