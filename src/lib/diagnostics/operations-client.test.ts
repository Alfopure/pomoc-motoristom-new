import {afterEach,describe,it,expect,vi} from 'vitest';
afterEach(()=>{vi.restoreAllMocks();vi.resetModules();});
describe('operation sampling and identity',()=>{
 it('decides sampling before the result and emits duration/correlation once',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>new Response(JSON.stringify({acceptedIds:JSON.parse(init!.body as string).events.map((e:{id:string})=>e.id)})));
  const random=vi.spyOn(Math,'random').mockReturnValue(.01);
  const client=await import('./client');client.setDiagnosticIdentity({profileId:crypto.randomUUID(),organizationId:crypto.randomUUID()});
  const operationId=crypto.randomUUID();const end=client.beginDiagnosticOperation('case.save','cases',{operationId});random.mockReturnValue(.99);end({outcome:'ok',durationMs:25});end({outcome:'failed'});await client.flushDiagnostics();
  const events=JSON.parse(fetcher.mock.calls[0][1]!.body as string).events;
  expect(events).toHaveLength(1);expect(events[0]).toMatchObject({sampled:true,sampleRate:.05,outcome:'ok',durationMs:25});expect(events[0].operationId).toBe(operationId);
 });
 it('never records completion under a different account',async()=>{
  vi.spyOn(Math,'random').mockReturnValue(.01);
  const client=await import('./client');const organizationId=crypto.randomUUID();client.setDiagnosticIdentity({profileId:crypto.randomUUID(),organizationId});
  const end=client.beginDiagnosticOperation('case.save','cases');client.setDiagnosticIdentity({profileId:crypto.randomUUID(),organizationId});end({outcome:'failed'});
  expect(client.getDiagnosticCoverage().queued).toBe(0);
 });
});
