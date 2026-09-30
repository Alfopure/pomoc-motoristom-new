import { beforeEach,describe,expect,it,vi } from 'vitest';
const f=vi.hoisted(()=>({rpc:vi.fn(),auth:vi.fn(),after:vi.fn()}));
vi.mock('@/lib/supabase/admin',()=>({createSupabaseAdminClient:()=>({rpc:f.rpc})}));
vi.mock('@/server/api-auth',()=>({requireDefaultMotoristActor:f.auth,assertSameOriginRequest:(r:Request)=>{if(r.headers.get('origin')!=='https://example.test')throw new Error('origin');}}));
vi.mock('next/server',()=>({after:f.after}));
import { diagnosticsEnvironment,ingestDiagnostics,parseDiagnosticQuery,readDiagnosticBody,readDiagnostics,runDiagnosticsMaintenance } from './service';
import { recordServerDiagnostic } from './record';
import { parseDiagnosticEvent } from '@/lib/diagnostics/types';
const id='00000000-0000-0000-0000-000000000001';const org='00000000-0000-0000-0000-000000000002';
const event={id,pageId:id,sequence:1,occurredAt:'2026-09-29T10:00:00.000Z',monotonicMs:1,type:'ui_error',module:'app',outcome:'failed',buildId:'build1',sampled:false,sampleRate:.05};
const actor={profileId:id,organizationId:org,role:'dispatcher'};
const request=(body:unknown,origin='https://example.test')=>new Request('https://example.test/api/diagnostics/events',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('DIAGNOSTICS_ENABLED','true');f.auth.mockResolvedValue(actor);f.rpc.mockReturnValue({abortSignal:vi.fn().mockResolvedValue({data:{acceptedIds:[id]},error:null})});});
describe('closed diagnostic envelope',()=>{
 it('rejects private fields, unknown enum and malformed IDs',()=>{expect(parseDiagnosticEvent(event)).toEqual(event);for(const extra of [{message:'canary@example.test'},{stack:'phone+421000'},{source:'server'},{organizationId:org},{reason:'secret'},{buildId:'https://token'},{durationMs:NaN},{id:'bad'},{occurredAt:'2026-02-30T12:00:00.000Z'}])expect(parseDiagnosticEvent({...event,...extra})).toBeNull();});
 it('refuses account switching before persistence',async()=>{const r=await ingestDiagnostics(request({actor:{...actor,profileId:org},events:[event]}));expect(r.status).toBe(400);const wrong=await ingestDiagnostics(request({actor:{profileId:org,organizationId:org},events:[event]}));expect(wrong.status).toBe(401);expect(f.rpc).not.toHaveBeenCalled();});
 it('only durable IDs are acknowledged and unavailable never confirms',async()=>{const body={actor:{profileId:id,organizationId:org},events:[event]};expect((await (await ingestDiagnostics(request(body))).json()).acceptedIds).toEqual([id]);f.rpc.mockReturnValue({abortSignal:vi.fn().mockResolvedValue({data:null,error:{message:'private DB detail'}})});const r=await ingestDiagnostics(request(body));expect(r.status).toBe(503);expect(await r.text()).not.toContain('private DB');});
 it('returns distributed throttling retry-after',async()=>{f.rpc.mockReturnValue({abortSignal:vi.fn().mockResolvedValue({data:{acceptedIds:[],rateLimited:true},error:null})});const r=await ingestDiagnostics(request({actor:{profileId:id,organizationId:org},events:[event]}));expect(r.status).toBe(429);expect(r.headers.get('retry-after')).toBe('60');});
 it('requires origin, bounded batches and strict identity',async()=>{expect((await ingestDiagnostics(request({actor:{profileId:id,organizationId:org},events:[event]},''))).status).toBe(403);expect((await ingestDiagnostics(request({actor:{profileId:id,organizationId:org},events:Array(17).fill(event)}))).status).toBe(400);expect(f.rpc).not.toHaveBeenCalled();});
 it('cancels a stalled upload instead of keeping background work alive past the endpoint deadline',async()=>{
  vi.useFakeTimers();
  const cancel=vi.fn();
  const r=new Request('https://example.test',{method:'POST',headers:{'content-type':'application/json'},body:new ReadableStream({cancel}),duplex:'half'} as RequestInit);
  const result=readDiagnosticBody(r).catch(error=>error);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toMatchObject({status:408});expect(cancel).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);vi.useRealTimers();
 });
 it('bounds actual stream bytes without Content-Length',async()=>{await expect(readDiagnosticBody(request({value:'x'.repeat(17000)}))).rejects.toMatchObject({status:413});});
});
describe('read and fail-open writes',()=>{
 it('keeps dedicated TEST ingestion, reads and maintenance in the TEST environment',async()=>{
  vi.stubEnv('MOTORIST_APP_ENV','test');vi.stubEnv('VERCEL_ENV','production');
  vi.stubEnv('DIAGNOSTICS_PANEL_ENABLED','true');vi.stubEnv('DIAGNOSTICS_PHYSICAL_BUDGET_BYTES','33554432');
  expect(diagnosticsEnvironment()).toBe('test');
  await ingestDiagnostics(request({actor:{profileId:id,organizationId:org},events:[event]}));
  await readDiagnostics(new Request('https://example.test'));
  await runDiagnosticsMaintenance(org);
  expect(f.rpc.mock.calls.map(([name,args])=>[name,args.p_environment])).toEqual([
   ['motorist_diagnostics_ingest','test'],['motorist_diagnostics_read','test'],['motorist_diagnostics_maintain','test'],
  ]);
  vi.stubEnv('MOTORIST_APP_ENV','production');expect(diagnosticsEnvironment()).toBe('production');
  vi.stubEnv('MOTORIST_APP_ENV',undefined);vi.stubEnv('VERCEL_ENV','preview');expect(diagnosticsEnvironment()).toBe('test');
  vi.stubEnv('VERCEL_ENV',undefined);expect(diagnosticsEnvironment()).toBe('development');
 });
 it('bounds ranges and cursor, rejects invalid timestamps',()=>{expect(()=>parseDiagnosticQuery(new Request('https://example.test?until=wrong'))).toThrow();expect(()=>parseDiagnosticQuery(new Request('https://example.test?since=2026-09-01&until=2026-09-29'))).toThrow();expect(()=>parseDiagnosticQuery(new Request('https://example.test?pageSize=101'))).toThrow();});
 it('gates read to manager/admin even when feature is off',async()=>{vi.stubEnv('DIAGNOSTICS_ENABLED','false');await readDiagnostics(new Request('https://example.test'));expect(f.auth).toHaveBeenCalledWith(['manager','admin']);expect(f.rpc).not.toHaveBeenCalled();});
 it('disables panel reads after authorization without disabling ingestion',async()=>{vi.stubEnv('DIAGNOSTICS_PANEL_ENABLED','false');const r=await readDiagnostics(new Request('https://example.test'));expect(r.status).toBe(503);expect(f.auth).toHaveBeenCalledWith(['manager','admin']);expect(f.rpc).not.toHaveBeenCalled();vi.stubEnv('DIAGNOSTICS_PANEL_ENABLED','true');});
 it('defers writes and absorbs failures outside request lifecycle',async()=>{f.after.mockImplementation(()=>{throw new Error('no request')});expect(()=>recordServerDiagnostic(actor,{type:'operation',module:'cases',outcome:'failed',operation:'case.save'})).not.toThrow();expect(f.rpc).not.toHaveBeenCalled();});
});
