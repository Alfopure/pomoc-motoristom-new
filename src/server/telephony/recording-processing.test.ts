import { describe, expect, it, vi } from 'vitest';
import { failedRecordingOutcome, recordingJobEnabled, recordingProcessingDeadline, runRecordingProcessing } from './recording-processing';
import { RecordingProcessingError, type RecordingAdmin, type RecordingJob, type RecordingPolicy } from './recording-jobs';
const policy={approved_at:'2026-09-06',recording_enabled:true,transcription_enabled:true,analysis_enabled:true} as RecordingPolicy;
describe('bounded durable coordinator',()=>{
 it('keeps 15s processing cap, 50s total cutoff and refuses work after live jobs consume reserve',async()=>{
  expect(recordingProcessingDeadline(0,10000)).toBe(25000);expect(recordingProcessingDeadline(0,45000)).toBe(50000);
  const from=vi.fn();const result=await runRecordingProcessing({admin:{from} as unknown as RecordingAdmin,organizationId:'org',cronStartedAt:Date.now()-48000});
  expect(result).toMatchObject({status:'skipped',detail:{reason:'live_safety_budget'}});expect(from).not.toHaveBeenCalled();
 });
 it('requires exact server master plus approved org flags, while deletion remains enabled',()=>{
  expect(recordingJobEnabled('asr',policy,{RECORDING_PROCESSING_ENABLED:'true',TRANSCRIPTS_ENABLED:'true'})).toBe(true);
  expect(recordingJobEnabled('asr',policy,{RECORDING_PROCESSING_ENABLED:'true',TRANSCRIPTS_ENABLED:'TRUE'})).toBe(false);
  expect(recordingJobEnabled('analysis',policy,{AI_TRANSCRIPT_ENABLED:'true'})).toBe(false);
  expect(recordingJobEnabled('delete',null,{})).toBe(true);
 });
 it('never automatically retries a possibly paid submission; cleanup has durable retry without exposing error text',()=>{
  const job={kind:'asr',attempt:0,paid_submit_started:true} as RecordingJob;
  expect(failedRecordingOutcome(job,new Error('secret transcript'))).toEqual({state:'submission_unknown',errorCode:'paid_submit_ack_unknown'});
  expect(failedRecordingOutcome({...job,kind:'delete',paid_submit_started:false,attempt:10},new Error('signed URL'))).toMatchObject({state:'waiting',errorCode:'recording_processing_failed'});
  expect(failedRecordingOutcome({...job,paid_submit_started:false},new RecordingProcessingError('temporary',true))).toMatchObject({state:'waiting',errorCode:'temporary'});
 });
});
