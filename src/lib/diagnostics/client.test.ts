import { describe,it,expect,vi } from 'vitest';
import { DiagnosticCollector } from './client';
import type { DiagnosticEvent, DiagnosticEventInput } from './types';
import type { StoredDiagnostics } from './persistence';
const profileId='11111111-1111-4111-8111-111111111111';
const organizationId='22222222-2222-4222-8222-222222222222';
const actor={profileId,organizationId};
const input: DiagnosticEventInput={type:'operation',module:'cases',operation:'case.save',outcome:'ok',sampled:true,sampleRate:.05};
function fixture(options:{fetch?:typeof fetch; saved?:StoredDiagnostics;online?:boolean}={}) {
  let now=Date.now();let online=options.online??true;
  const persistence={read:vi.fn(async()=>options.saved??null),write:vi.fn<(value:StoredDiagnostics|null)=>Promise<void>>(async()=>{})};
  const fetcher=options.fetch??vi.fn(async()=>new Response(JSON.stringify({acceptedIds:[]})));
  const collector=new DiagnosticCollector({pageId:profileId,buildId:'build_123',persistence,now:()=>now,monotonic:()=>123,random:()=>0,online:()=>online,fetch:fetcher});
  collector.setIdentity(actor);
  return {collector,persistence,fetcher,advance:(ms:number)=>{now+=ms;},setOnline:(value:boolean)=>{online=value;}};
}
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
describe('bounded diagnostic collector',()=>{
  it('never attributes an anonymous bootstrap error to a subsequent account',async()=>{
    const collector=new DiagnosticCollector({pageId:profileId,buildId:'test',persistence:{read:async()=>null,write:async()=>{}}});
    expect(collector.record({type:'ui_error',module:'app',outcome:'failed',errorClass:'TypeError'})).toBeNull();
    collector.setIdentity(actor);await settle();
    expect(collector.coverage()).toMatchObject({queued:0,bytes:2,dropped:0});
  });

  it('bounds 10,000 inputs to 200 events/128 KiB and sends at most 16/16KiB with bound actor',async()=>{
    const f=fixture(); await settle();
    for(let i=0;i<10000;i++) f.collector.record(input);
    expect(f.collector.coverage()).toMatchObject({queued:200,dropped:9800});
    expect(f.collector.coverage().bytes).toBeLessThanOrEqual(128*1024);
    await f.collector.flush();
    const body=JSON.parse((vi.mocked(f.fetcher).mock.calls[0][1]!.body as string));
    expect(body.events).toHaveLength(16);expect(body.actor).toEqual(actor);
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThanOrEqual(16*1024);
  });
  it('deduplicates repetitive errors without raw fields',async()=>{
    const f=fixture({online:false});await settle();
    for(let i=0;i<10000;i++)f.collector.record({type:'ui_error',module:'app',outcome:'failed',errorClass:'TypeError'});
    expect(f.collector.coverage()).toMatchObject({queued:1,deduplicated:9999});
    expect(f.collector.record({...input,message:'phone +421 email@test token'} as DiagnosticEventInput)).toBeNull();
  });
  it('removes only explicit durable ACK IDs, tracks rejections as drops',async()=>{
    const fetcher=vi.fn(async(_url: unknown,init?:RequestInit)=>{const events=JSON.parse(init!.body as string).events;return new Response(JSON.stringify({acceptedIds:[events[0].id,'bogus'],rejectedIds:[events[1].id],degraded:true}));});
    const f=fixture({fetch:fetcher});await settle();
    const first=f.collector.record(input)!;f.collector.record(input);f.collector.record(input);
    await f.collector.flush();
    expect(f.collector.isConfirmed(first)).toBe(true);
    expect(f.collector.coverage()).toMatchObject({queued:1,dropped:1,degraded:true});
  });
  it('backs off 5/15/60/300 seconds; honors Retry-After and stops offline',async()=>{
    const f=fixture({fetch:vi.fn(async()=>new Response('',{status:503}))});await settle();f.collector.record(input);
    for(const delay of [5000,15000,60000,300000]){const before=vi.mocked(f.fetcher).mock.calls.length;await f.collector.flush();expect(vi.mocked(f.fetcher).mock.calls.length).toBe(before+1);f.advance(delay-1);await f.collector.flush();expect(vi.mocked(f.fetcher).mock.calls.length).toBe(before+1);f.advance(1);}
    f.setOnline(false);await f.collector.flush();expect(vi.mocked(f.fetcher)).toHaveBeenCalledTimes(4);
    const rate=fixture({fetch:vi.fn(async()=>new Response('',{status:429,headers:{'Retry-After':'120'}}))});await settle();rate.collector.record(input);await rate.collector.flush();rate.advance(119999);await rate.collector.flush();expect(rate.fetcher).toHaveBeenCalledTimes(1);rate.advance(1);await rate.collector.flush();expect(rate.fetcher).toHaveBeenCalledTimes(2);
  });
  it('never sends empty requests and caps attempts at 12/minute',async()=>{
    const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>new Response(JSON.stringify({acceptedIds:JSON.parse(init!.body as string).events.map((e:DiagnosticEvent)=>e.id)})));
    const f=fixture({fetch:fetcher});await settle();await f.collector.flush();expect(fetcher).not.toHaveBeenCalled();
    for(let i=0;i<40;i++){f.collector.record(input);await f.collector.flush();f.advance(1000);}
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(12);
  });
  it('expires after 24 hours and restores only same-actor sanitized records',async()=>{
    const f=fixture();await settle();f.collector.record(input);await settle();const saved=f.persistence.write.mock.calls.at(-1)?.[0] as StoredDiagnostics;
    const restored=fixture({saved});await settle();expect(restored.collector.coverage().queued).toBe(1);restored.advance(86400001);await restored.collector.flush();expect(restored.collector.coverage().queued).toBe(1);expect(JSON.parse(vi.mocked(restored.fetcher).mock.calls[0][1]!.body as string).events[0]).toMatchObject({type:"coverage",reason:"queue_drop",count:1});
    const foreign=fixture({saved:{...saved,actor:{...actor,profileId:organizationId}}});await settle();expect(foreign.collector.coverage().queued).toBe(0);
  });
  it('clears on logout/account switch and ignores a late response from old actor',async()=>{
    let resolve!:(r:Response)=>void;
    const f=fixture({fetch:vi.fn(()=>new Promise<Response>(r=>{resolve=r;}))});await settle();const id=f.collector.record(input)!;
    const request=f.collector.flush();await settle();f.collector.setIdentity({...actor,profileId:organizationId});f.collector.record(input);
    resolve(new Response(JSON.stringify({acceptedIds:[id]})));await request;
    expect(f.collector.isConfirmed(id)).toBe(false);expect(f.collector.coverage().queued).toBe(1);
    f.collector.setIdentity(null);expect(f.collector.coverage().queued).toBe(0);expect(f.collector.record(input)).toBeNull();
  });
  it('401 disables retries and storage/transport exceptions do not escape',async()=>{
    const f=fixture({fetch:vi.fn(async()=>new Response('',{status:401}))});await settle();f.collector.record(input);await expect(f.collector.flush()).resolves.toBeUndefined();expect(f.collector.coverage().queued).toBe(0);expect(f.collector.record(input)).toBeNull();
    const g=fixture({fetch:vi.fn(async()=>{throw Error('failure');})});await settle();g.collector.record(input);await expect(g.collector.flush()).resolves.toBeUndefined();expect(g.collector.coverage().degraded).toBe(true);
  });
});
