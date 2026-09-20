import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase, fakeError, type FakeRow } from '@/test/fake-supabase';
let fake: ReturnType<typeof createFakeSupabase>;
vi.mock('@/lib/supabase/admin',()=>({createSupabaseAdminClient:()=>fake.admin}));
import { loadTelephonyCallHistory, searchTelephonyCallHistory } from './call-history';
import { parseCallHistoryQuery, decodeHistoryCursor } from '@/lib/telephony/call-history-query';

beforeEach(()=>{
 fake=createFakeSupabase();
 fake.db.seed('motorist_calls',[{id:'call',organization_id:'org',direction:'inbound',status:'ended',started_at:'2026-09-06T10:00:00Z',ended_at:'2026-09-06T10:00:20Z',created_at:'2026-09-06T10:00:00Z',duration_seconds:20,caller_number:'+421900000000',recording_status:'not_requested'}]);
});

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor={organizationId:'org',profileId:id(99999)};
const stamp='2026-09-20T05:00:00.000000Z';
const historyRow=(n:number,patch:FakeRow={})=>({id:id(n),organization_id:'org',session_id:null,started_at:stamp,created_at:stamp,ended_at:stamp,answered_at:null,direction:'inbound',status:'missed',end_reason:'normal_clearing',raw_latest_payload:{},caller_name:'Caller',caller_number:'+421900000000',recording_status:'not_requested',...patch});
function ordered(left:FakeRow,right:FakeRow) {
 if(left.started_at===null&&right.started_at!==null)return 1;
 if(left.started_at!==null&&right.started_at===null)return -1;
 if(left.started_at!==right.started_at)return String(right.started_at).localeCompare(String(left.started_at));
 return String(right.id).localeCompare(String(left.id));
}
function installRpc(rows:FakeRow[]) {
 const handler=vi.fn((args:FakeRow)=>{
  if(args.p_actor_id!==actor.profileId)throw fakeError('Denied','42501');
  return rows.filter(row=>row.organization_id===args.p_organization_id)
   .filter(row=>!args.p_direction||row.direction===args.p_direction)
   .filter(row=>!args.p_outcome||(args.p_outcome==='answered'?row.answered_at!==null:row.status===args.p_outcome||(row.raw_latest_payload as FakeRow).outcome===args.p_outcome))
   .filter(row=>!args.p_query||String(row.caller_name).includes(String(args.p_query)))
   .filter(row=>!args.p_from||(row.started_at!==null&&String(row.started_at)>=String(args.p_from)))
   .filter(row=>!args.p_to||(row.started_at!==null&&String(row.started_at)<String(args.p_to)))
   .filter(row=>!args.p_operator_id||row.operator_id===args.p_operator_id)
   .filter(row=>!args.p_line_id||row.line_id===args.p_line_id)
   .filter(row=>!args.p_cursor_id||ordered(row,{id:args.p_cursor_id,started_at:args.p_cursor_at})>0)
   .sort(ordered).slice(0,Number(args.p_limit));
 });
 fake.db.registerRpc('motorist_search_call_history',handler);return handler;
}
const search=(params:Record<string,string>={})=>searchTelephonyCallHistory(actor,parseCallHistoryQuery(new URLSearchParams(params)),fake.admin);

describe('quick history categories over the complete authorized history',()=>{
 it('classifies received as inbound answered and outbound as all outbound outcomes',async()=>{
  installRpc([
   historyRow(1,{status:'ended',answered_at:stamp}),
   historyRow(2,{direction:'outbound',status:'ended',answered_at:stamp}),
   historyRow(3,{direction:'outbound',status:'ended'}),
   historyRow(4,{direction:'internal',status:'ended',answered_at:stamp}),
   historyRow(5,{status:'answered',answered_at:stamp,ended_at:null}),
  ]);
  expect((await search({category:'received'})).calls.map(row=>row.id)).toEqual([id(5),id(1)]);
  expect((await search({category:'outbound'})).calls.map(row=>row.id)).toEqual([id(3),id(2)]);
  expect((await search({category:'all',direction:'internal',outcome:'answered'})).calls.map(row=>row.id)).toEqual([id(4)]);
 });

 it('includes waiting-room abandonment and all-busy, excluding live, answered, failed and system/callback closures',async()=>{
  installRpc([
   historyRow(1),historyRow(2,{status:'abandoned_queue',end_reason:'abandoned_in_queue'}),historyRow(3,{end_reason:'all_busy'}),
   historyRow(4,{end_reason:'after_hours'}),historyRow(5,{end_reason:'ivr_message'}),historyRow(6,{end_reason:'callback_requested'}),
   historyRow(7,{raw_latest_payload:{callback:{confirmed:true}}}),historyRow(8,{raw_latest_payload:{callback:{kind:'requested'}}}),
   historyRow(9,{answered_at:stamp}),historyRow(10,{ended_at:null}),historyRow(11,{direction:'outbound'}),historyRow(12,{status:'failed'}),
  ]);
  expect((await search({category:'missed'})).calls.map(row=>row.id)).toEqual([id(3),id(2),id(1)]);
 });

 it('merges skewed status streams with tied timestamps and preserves global paging without losses or duplicates',async()=>{
  const rows=Array.from({length:330},(_,n)=>historyRow(n+1,{status:n<220?'missed':'abandoned_queue',...(n%13===0?{end_reason:'after_hours'}:{}),...(n<5?{started_at:null}:{})}));
  installRpc(rows);
  const expected=rows.filter(row=>row.end_reason!=='after_hours').sort(ordered).map(row=>row.id);
  const actual:string[]=[];let cursor:string|undefined;
  do {
   const result=await search({category:'missed',limit:'37',...(cursor?{cursor}:{})});
   actual.push(...result.calls.map(row=>row.id));cursor=result.nextCursor??undefined;
  } while(cursor);
  expect(actual).toEqual(expected);expect(new Set(actual).size).toBe(expected.length);
 });

 it('refills the newest stream before consuming much older rows from the other stream',async()=>{
  const rows=Array.from({length:150},(_,n)=>historyRow(n+1));
  rows.push(historyRow(900,{status:'abandoned_queue',started_at:'2026-09-19T05:00:00.000000Z'}));
  installRpc(rows);
  const page=await search({category:'missed',limit:'100'});
  expect(page.calls.map(row=>row.id)).toEqual(rows.slice(0,150).sort(ordered).slice(0,100).map(row=>row.id));
  const rest=await search({category:'missed',limit:'100',cursor:page.nextCursor!});
  expect(rest.calls.map(row=>row.id)).toEqual([...rows.slice(0,50).sort(ordered).map(row=>row.id),id(900)]);
 });

 it('keeps PostgreSQL microseconds in cross-stream order and the next cursor',async()=>{
  installRpc([
   historyRow(8,{status:'abandoned_queue',started_at:'2026-09-20T05:00:00.000001Z'}),
   historyRow(1,{started_at:'2026-09-20T05:00:00.000003Z'}),
   historyRow(9,{status:'abandoned_queue',started_at:'2026-09-20T05:00:00.000002Z'}),
  ]);
  const first=await search({category:'missed',limit:'1'});
  expect(first.calls[0].id).toBe(id(1));expect(decodeHistoryCursor(first.nextCursor)?.startedAt).toBe('2026-09-20T05:00:00.000003Z');
  expect((await search({category:'missed',cursor:first.nextCursor!,limit:'10'})).calls.map(row=>row.id)).toEqual([id(9),id(8)]);
 });

 it('returns an honest resumable empty page when bounded scanning meets many excluded records',async()=>{
  const rows=Array.from({length:900},(_,n)=>historyRow(n+2,{end_reason:'after_hours'}));rows.push(historyRow(1));
  const rpc=installRpc(rows);
  const first=await search({category:'missed',limit:'25'});
  expect(first).toMatchObject({calls:[],scanLimited:true});expect(first.nextCursor).not.toBeNull();expect(rpc).toHaveBeenCalledTimes(8);
  const second=await search({category:'missed',limit:'25',cursor:first.nextCursor!});
  expect(second.calls.map(row=>row.id)).toEqual([id(1)]);expect(second).toMatchObject({scanLimited:false,nextCursor:null});
 });

 it('continues after the last examined row when a bounded page contains only a few matches',async()=>{
  installRpc([historyRow(2000),...Array.from({length:900},(_,n)=>historyRow(n+2,{end_reason:'ivr_message'})),historyRow(1)]);
  const first=await search({category:'missed',limit:'25'});
  expect(first.calls.map(row=>row.id)).toEqual([id(2000)]);expect(first.scanLimited).toBe(true);
  expect(decodeHistoryCursor(first.nextCursor)?.id).not.toBe(id(2000));
  expect((await search({category:'missed',limit:'25',cursor:first.nextCursor!})).calls.map(row=>row.id)).toEqual([id(1)]);
 });

 it('keeps only an explicit recent-history fallback if both missed streams lack the migration',async()=>{
  fake.db.registerRpc('motorist_search_call_history',()=>{throw fakeError('Missing','PGRST202');});
  const result=await search({category:'missed',q:'not in the recent history'});
  expect(result).toMatchObject({searchAvailable:false,scanLimited:false,nextCursor:null});
  expect(result.calls.map(row=>row.id)).toEqual(['call']);
 });

 it('fails closed if a refill is denied after some matches have already been collected',async()=>{
  const handler=installRpc(Array.from({length:110},(_,n)=>historyRow(n+1)));
  // Query 100 needs the 101st lookahead; excluded rows force a second batch.
  fake.db.registerRpc('motorist_search_call_history',args=>{
   if(args.p_cursor_id)throw fakeError('Membership revoked','42501');
   return handler(args).map((row,index)=>index===0?{...row,end_reason:'after_hours'}:row);
  });
  await expect(search({category:'missed',limit:'100'})).rejects.toMatchObject({status:403});
 });

 it('forwards the full query/date/operator/line scope to every stream read and excludes another organization',async()=>{
  const rpc=installRpc([historyRow(1,{caller_name:'Wanted',operator_id:id(10),line_id:id(20)}),historyRow(2,{organization_id:'foreign',caller_name:'Wanted',operator_id:id(10),line_id:id(20)})]);
  const result=await search({category:'missed',q:'Wanted',from:'2026-09-20',to:'2026-09-20',operatorId:id(10),lineId:id(20)});
  expect(result.calls.map(row=>row.id)).toEqual([id(1)]);
  for(const [args] of rpc.mock.calls)expect(args).toMatchObject({p_organization_id:'org',p_actor_id:actor.profileId,p_query:'Wanted',p_from:'2026-09-19T22:00:00.000Z',p_to:'2026-09-20T22:00:00.000Z',p_operator_id:id(10),p_line_id:id(20),p_direction:'inbound'});
 });

 it('deduplicates a row that the RPC returns under both exact outcome streams',async()=>{
  installRpc([historyRow(1,{status:'abandoned_queue',raw_latest_payload:{outcome:'missed'}})]);
  expect((await search({category:'missed'})).calls.map(row=>row.id)).toEqual([id(1)]);
 });

 it.each(['bad-id','bad-time','out-of-order','duplicate','foreign'])('fails closed for malformed RPC data: %s',async kind=>{
  const rows=kind==='bad-id'?[historyRow(1,{id:'bad'})]:kind==='bad-time'?[historyRow(1,{started_at:'yesterday'})]:kind==='foreign'?[historyRow(1,{organization_id:'foreign'})]:kind==='duplicate'?[historyRow(1),historyRow(1)]:[historyRow(1),historyRow(2)];
  fake.db.registerRpc('motorist_search_call_history',()=>rows);
  await expect(search()).rejects.toThrow();
 });

 it('never turns a denied stream into a limited fallback when another stream reports missing schema',async()=>{
  fake.db.registerRpc('motorist_search_call_history',args=>{throw fakeError('No access',args.p_outcome==='missed'?'PGRST202':'42501');});
  await expect(search({category:'missed'})).rejects.toMatchObject({status:403});
  expect(fake.db.log.some(entry=>entry.table==='motorist_calls')).toBe(false);
 });
});

describe('history callback relationship and waiting metadata',()=>{
 it('reads the actual org/session callback lifecycle, using the latest request and its claimant',async()=>{
  fake.db.seed('motorist_calls',[historyRow(10,{session_id:id(100),provider_session_id:id(777),wait_seconds:0,end_reason:'abandoned_in_queue'}),historyRow(11,{session_id:id(101),wait_seconds:null,raw_latest_payload:{outcome:'callback'}})]);
  fake.db.seed('motorist_profiles',[{id:id(55),organization_id:'org',display_name:'Dispečer'},{id:id(56),organization_id:'foreign',display_name:'Foreign secret'}]);
  fake.db.seed('motorist_callback_requests',[
   {id:id(1),organization_id:'org',session_id:id(100),status:'done',created_at:'2026-09-19T05:00:00Z',claimed_by:id(55)},
   {id:id(2),organization_id:'org',session_id:id(100),status:'scheduled',created_at:stamp,claimed_by:id(55),due_at:'2026-09-20T06:00:00Z'},
   {id:id(3),organization_id:'foreign',session_id:id(100),status:'cancelled',created_at:'2026-09-21T05:00:00Z',claimed_by:id(56)},
   {id:id(4),organization_id:'org',session_id:id(777),status:'cancelled',created_at:'2026-09-21T05:00:00Z'},
  ]);
  const history=await loadTelephonyCallHistory('org');
  expect(history.find(row=>row.id===id(10))).toMatchObject({waitSeconds:0,waitSecondsKnown:true,endReason:'abandoned_in_queue',callback:{status:'scheduled',claimedByName:'Dispečer',dueAt:'2026-09-20T06:00:00Z'}});
  expect(history.find(row=>row.id===id(11))).toMatchObject({waitSecondsKnown:false});expect(history.find(row=>row.id===id(11))?.callback).toBeUndefined();
  expect(JSON.stringify(history)).not.toContain('Foreign secret');
  expect(fake.db.log.filter(entry=>entry.table==='motorist_callback_requests')[0].filters).toEqual(expect.arrayContaining(['eq(organization_id)','in(session_id)']));
 });

 it('does not claim no callback when the relationship read fails',async()=>{
  fake.db.seed('motorist_calls',[historyRow(20,{session_id:id(200)})]);fake.db.failNext('motorist_callback_requests','select',failure('42501'));
  await expect(loadTelephonyCallHistory('org')).rejects.toThrow('Telephony call history relations could not be loaded');
 });
});
const failure=(code:string)=>({code,message:'Synthetic database error',details:null,hint:null});
describe('call history before and after recording migration',()=>{
 it.each(['42703','PGRST204','42P01','PGRST205'])('preserves existing history with no recording badges when schema is absent (%s)',async(code)=>{
  fake.db.failNext('motorist_call_recordings','select',failure(code));
  const history=await loadTelephonyCallHistory('org');expect(history).toHaveLength(1);expect(history[0]).toMatchObject({id:'call',status:'ended',callerNumber:'+421900000000'});expect(history[0].recordingId).toBeUndefined();
  const recordingReads=fake.db.log.filter(x=>x.table==='motorist_call_recordings');expect(recordingReads).toHaveLength(1);
  expect(recordingReads[0].filters).toEqual(expect.arrayContaining(['eq(organization_id)','eq(status)','is(deleted_at)','is(restricted_at)']));
 });
 it.each(['42501','08006','PGRST301'])('does not hide unrelated recording database errors (%s)',async(code)=>{
  fake.db.failNext('motorist_call_recordings','select',failure(code));await expect(loadTelephonyCallHistory('org')).rejects.toThrow('Telephony call history relations could not be loaded');
 });
 it('continues to surface missing required history relations even when the recording schema is also absent',async()=>{
  fake.db.failNext('motorist_call_events','select',failure('42P01'));fake.db.failNext('motorist_call_recordings','select',failure('42703'));
  await expect(loadTelephonyCallHistory('org')).rejects.toThrow('Telephony call history relations could not be loaded');
 });
 it('shows only an available recording that passes all existing privacy filters after migration',async()=>{
  fake.db.seed('motorist_call_recordings',[
   {id:'valid',organization_id:'org',call_id:'call',status:'available',created_at:'2026-09-06T10:00:21Z',deleted_at:null,restricted_at:null,expires_at:null},
   {id:'deleted',organization_id:'org',call_id:'call',status:'available',created_at:'2026-09-06T10:00:25Z',deleted_at:'2026-09-06T10:00:25Z',restricted_at:null,expires_at:null},
   {id:'restricted',organization_id:'org',call_id:'call',status:'available',created_at:'2026-09-06T10:00:24Z',deleted_at:null,restricted_at:'2026-09-06T10:00:24Z',expires_at:null},
   {id:'expired',organization_id:'org',call_id:'call',status:'available',created_at:'2026-09-06T10:00:23Z',deleted_at:null,restricted_at:null,expires_at:'2000-01-01T00:00:00Z'},
   {id:'other-org',organization_id:'other',call_id:'call',status:'available',created_at:'2026-09-06T10:00:26Z',deleted_at:null,restricted_at:null,expires_at:null},
  ]);
  expect((await loadTelephonyCallHistory('org'))[0].recordingId).toBe('valid');
 });
});
