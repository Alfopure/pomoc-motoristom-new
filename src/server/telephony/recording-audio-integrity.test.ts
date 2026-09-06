import { describe, expect, it } from 'vitest';
import { pcmWav } from '@/test/recording-wav-fixture';
import { inspectRecordingWav, preserveRecordingAudioProvenance } from './recording-audio-integrity';

describe('bounded PCM WAV integrity and measured duration',()=>{
 it.each([0.04,3.62,3.7,6.3])('measures %s seconds from PCM data rather than provider metadata',seconds=>{
  const bytes=pcmWav(Math.round(seconds*192000));const result=inspectRecordingWav(bytes,bytes.length);
  expect(result).toMatchObject({audioDurationSeconds:seconds,dataOffset:44,dataBytes:bytes.length-44,audioFormat:{channels:2,sampleRate:48000,bitsPerSample:16}});
 });
 it('measures a multi-chunk file from only its first6MiB and the verified total',()=>{
  const bytes=pcmWav(8*1024*1024);expect(inspectRecordingWav(bytes.subarray(0,6*1024*1024),bytes.length).audioDurationSeconds).toBe((bytes.length-44)/192000);
 });
 it('supports padded unknown chunks before fmt/data within the header budget',()=>{
  const original=pcmWav(19200);const bytes=Buffer.concat([original.subarray(0,12),Buffer.from([74,85,78,75,1,0,0,0,65,0]),original.subarray(12)]);bytes.writeUInt32LE(bytes.length-8,4);
  expect(inspectRecordingWav(bytes,bytes.length)).toMatchObject({audioDurationSeconds:0.1,dataOffset:54});
 });
 it.each(['riff-total','data-total','data-alignment','block-alignment','byte-rate','codec','truncated-header','data-before-fmt'])('rejects malformed or unsupported %s before storage upload',kind=>{
  const bytes=pcmWav(19200);
  if(kind==='riff-total')bytes.writeUInt32LE(bytes.length,4);
  if(kind==='data-total')bytes.writeUInt32LE(19204,40);
  if(kind==='data-alignment')bytes.writeUInt32LE(19199,40);
  if(kind==='block-alignment')bytes.writeUInt16LE(2,32);
  if(kind==='byte-rate')bytes.writeUInt32LE(96000,28);
  if(kind==='codec')bytes.writeUInt16LE(3,20);
  if(kind==='data-before-fmt')bytes.write('data',12);
  expect(()=>inspectRecordingWav(kind==='truncated-header'?bytes.subarray(0,30):bytes,bytes.length)).toThrow();
 });
 it('bounds pathological unknown metadata before PCM data without another fetch',()=>{
  const bytes=Buffer.alloc(6*1024*1024);bytes.write('RIFF');bytes.writeUInt32LE(8*1024*1024-8,4);bytes.write('WAVE',8);bytes.write('JUNK',12);bytes.writeUInt32LE(7*1024*1024,16);
  expect(()=>inspectRecordingWav(bytes,8*1024*1024)).toThrow('wav_header_limit');
 });
 it('topology refresh cannot erase measured timing failure or reinstate conversation completeness',()=>{
  const existing={audioDurationSeconds:0.04,audioFormat:{channels:2},timingVerified:false,timingDriftSeconds:3.835,timingWarning:'audio_provider_duration_mismatch'};
  expect(preserveRecordingAudioProvenance(existing,{openingComplete:true,conversationComplete:true,closingComplete:true,timingVerified:true,intervals:[]})).toMatchObject({...existing,openingComplete:false,conversationComplete:false,closingComplete:false});
  expect(preserveRecordingAudioProvenance({}, {conversationComplete:true})).toMatchObject({timingVerified:false,audioDurationSeconds:null,conversationComplete:false});
 });
 it('preserves valid independent timing while refreshing conservative topology flags',()=>{
  expect(preserveRecordingAudioProvenance({audioDurationSeconds:3.7,timingVerified:true,timingWarning:null},{openingComplete:false,conversationComplete:true,closingComplete:true})).toMatchObject({audioDurationSeconds:3.7,timingVerified:true,openingComplete:false,conversationComplete:true});
 });
});
