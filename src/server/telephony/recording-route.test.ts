import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MutationError } from '@/server/mutation-error';
const fixture=vi.hoisted(()=>({auth:vi.fn(),admin:{marker:'admin'}}));
vi.mock('@/lib/supabase/admin',()=>({createSupabaseAdminClient:()=>fixture.admin}));
vi.mock('@/server/api-auth',async original=>({...await original<typeof import('@/server/api-auth')>(),requireDefaultMotoristActor:fixture.auth}));
import { recordingRoute, readRecordingBody } from './recording-route';
const actor={organizationId:'org',profileId:'profile',userId:'user',role:'dispatcher',displayName:'Synthetic'};
beforeEach(()=>{fixture.auth.mockReset().mockResolvedValue(actor);vi.stubEnv('MOTORIST_DEV_AUTH_BYPASS','false');});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
describe('recording HTTP boundary',()=>{
 it('rejects mismatched Origin before authentication or a mutation',async()=>{
  const run=vi.fn();const response=await recordingRoute(new Request('https://app.test/api',{method:'POST',headers:{origin:'https://evil.test',host:'app.test','content-type':'application/json'},body:'{}'}),run);
  expect(response.status).toBe(403);expect(fixture.auth).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
 });
 it('rejects unauthenticated reads before admin work and sets no-store on errors',async()=>{
  fixture.auth.mockRejectedValue(new MutationError('Sign in',401));const run=vi.fn();const response=await recordingRoute(new Request('https://app.test/api'),run);
  expect(response.status).toBe(401);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(run).not.toHaveBeenCalled();
 });
 it('passes the authenticated actor and bounded JSON, with private no-store responses',async()=>{
  const run=vi.fn().mockResolvedValue({okay:true});const response=await recordingRoute(new Request('https://app.test/api',{method:'POST',headers:{origin:'https://app.test',host:'app.test','content-type':'application/json'},body:'{"note":"Synthetic"}'}),run);
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(run).toHaveBeenCalledWith({admin:fixture.admin,actor,body:{note:'Synthetic'}});
 });
 it('caps streamed body bytes without trusting Content-Length, and rejects arrays or non-JSON',async()=>{
  await expect(readRecordingBody(new Request('https://app.test/api',{method:'POST',headers:{'content-type':'application/json'},body:'{"value":"over cap"}'}),8)).rejects.toMatchObject({status:413});
  await expect(readRecordingBody(new Request('https://app.test/api',{method:'POST',headers:{'content-type':'application/json'},body:'[]'}))).rejects.toMatchObject({status:400});
  await expect(readRecordingBody(new Request('https://app.test/api',{method:'POST',headers:{'content-type':'text/plain'},body:'{}'}))).rejects.toMatchObject({status:415});
 });
 it('never logs raw unexpected errors carrying a private provider URL or transcript',async()=>{
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});const secret='https://provider.test/audio?token=private Private synthetic transcript';
  const response=await recordingRoute(new Request('https://app.test/api'),async()=>{throw new Error(secret);});
  expect(response.status).toBe(503);expect(await response.text()).not.toContain(secret);expect(JSON.stringify(log.mock.calls)).not.toContain('private');
  expect(log.mock.calls.some(call=>call.some(x=>x instanceof Error&&x.message.includes('Private synthetic')))).toBe(false);
 });
});
