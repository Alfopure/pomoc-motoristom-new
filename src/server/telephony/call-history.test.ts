import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from '@/test/fake-supabase';
let fake: ReturnType<typeof createFakeSupabase>;
vi.mock('@/lib/supabase/admin',()=>({createSupabaseAdminClient:()=>fake.admin}));
import { loadTelephonyCallHistory } from './call-history';

beforeEach(()=>{
 fake=createFakeSupabase();
 fake.db.seed('motorist_calls',[{id:'call',organization_id:'org',direction:'inbound',status:'ended',started_at:'2026-09-06T10:00:00Z',ended_at:'2026-09-06T10:00:20Z',created_at:'2026-09-06T10:00:00Z',duration_seconds:20,caller_number:'+421900000000',recording_status:'not_requested'}]);
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
