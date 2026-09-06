import { describe, expect, it } from 'vitest';
import { buildQualitySource, type RecordingSourceRows } from './recording-source';

const at=(seconds:number)=>new Date(Date.parse('2026-09-06T10:00:00Z')+seconds*1000).toISOString();
function fixture():RecordingSourceRows {
 const span=(id:string,operatorId:string,startSeconds:number)=>({id,transcriptId:'t',segmentId:'r',startSeconds,endSeconds:startSeconds+1,text:'Synthetic evidence',speakerLabel:'Speaker',role:'operator',operatorId,identityVerified:true});
 const interval=(profile_id:string|null,role:string,start:number,end:number)=>({profile_id,role,started_at:at(start),ended_at:at(end),audible_to_customer:true,verified:true,channel:role==='operator'?1:0,reason:'bridge',source_event_id:profile_id??'customer'});
 return {
  call:{id:'call',started_at:at(0),answered_at:at(0),ended_at:at(20),recording_source_revision:2},
  recordings:[{id:'r',source_revision:1,status:'available',participant_manifest:{channelMappingVerified:true,openingComplete:true,conversationComplete:true,closingComplete:true,gaps:[]}}],
  transcripts:[{id:'t',recording_id:'r',audio_source_revision:1,source_revision:3,status:'complete',language:'sk',speaker_segments:[span('a','a',1),span('b','b',11)]}],
  intervals:[interval(null,'customer',0,20),interval('a','operator',0,10),interval('b','operator',10,20)],
  profiles:[{id:'a',display_name:'A'},{id:'b',display_name:'B'}],
 } as unknown as RecordingSourceRows;
}
describe('immutable source and participant proof',()=>{
 it('keeps corrected text revision independent of audio revision and limits opening/closing absence proof to the boundary operator',()=>{
  const result=buildQualitySource(fixture());expect(result.spans.every(s=>s.identityVerified)).toBe(true);
  expect(result.subjects).toEqual([{id:'a',name:'A',identityVerified:true,openingComplete:true,conversationComplete:true,closingComplete:false},{id:'b',name:'B',identityVerified:true,openingComplete:false,conversationComplete:true,closingComplete:true}]);
 });
 it('rejects stored identity outside the exact audible verified participant interval',()=>{
  const rows=fixture();rows.intervals[1].ended_at=at(1.5);
  expect(buildQualitySource(rows).spans[0]).toMatchObject({role:'unknown',operatorId:null,identityVerified:false});
  rows.intervals[1].ended_at=at(10);rows.intervals[1].audible_to_customer=false;
  expect(buildQualitySource(rows).spans[0].identityVerified).toBe(false);
 });
 it('requires unambiguous channel proof and a current authenticated profile for each attributed span',()=>{
  const rows=fixture();rows.intervals.push({...rows.intervals[1]});expect(buildQualitySource(rows).spans[0].identityVerified).toBe(false);
  rows.intervals.pop();rows.intervals[1].channel=0;expect(buildQualitySource(rows).spans[0].identityVerified).toBe(false);
  rows.intervals[1].channel=1;rows.profiles=rows.profiles.filter(p=>p.id!=='a');expect(buildQualitySource(rows).spans[0].identityVerified).toBe(false);
 });
 it('does not infer missing conduct from malformed or stale source spans',()=>{
  for(const mutation of [(r:RecordingSourceRows)=>{r.transcripts[0].audio_source_revision=2;},(r:RecordingSourceRows)=>{r.transcripts[0].speaker_segments=[...(r.transcripts[0].speaker_segments as unknown[]),{id:'bad',text:'Unbounded',startSeconds:19,endSeconds:25} ] as never;}]){
   const rows=fixture();mutation(rows);expect(buildQualitySource(rows).subjects.every(s=>!s.openingComplete&&!s.conversationComplete&&!s.closingComplete)).toBe(true);
  }
 });
 it('live objection or one restricted source disables completeness for the entire logical call',()=>{
  const rows=fixture();rows.sessionRecordingSuppressed=true;expect(buildQualitySource(rows).subjects.every(s=>!s.conversationComplete)).toBe(true);
  rows.sessionRecordingSuppressed=false;rows.recordings[0].restricted_at=at(21);expect(buildQualitySource(rows).subjects.every(s=>!s.conversationComplete)).toBe(true);
 });
});
