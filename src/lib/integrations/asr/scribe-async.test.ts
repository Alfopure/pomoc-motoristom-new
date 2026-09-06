import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { submitScribeAsync, verifyScribeSignature } from './scribe-async';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('Scribe signed callbacks', () => {
 const raw='{"type":"speech_to_text_transcription"}', secret='synthetic-webhook-secret', now=1700000000000;
 const digest=createHmac('sha256',secret).update(`1700000000.${raw}`).digest('hex');
 it('accepts exact raw body and rejects alteration, stale/future timestamp, duplicate timestamps and bad hex', () => {
  expect(verifyScribeSignature(raw,`t=1700000000,v0=${digest}`,secret,now)).toBe(true);
  expect(verifyScribeSignature(raw+' ',`t=1700000000,v0=${digest}`,secret,now)).toBe(false);
  expect(verifyScribeSignature(raw,`t=1700000000,v0=${digest}`,secret,now+301000)).toBe(false);
  expect(verifyScribeSignature(raw,`t=1700000000,v0=${digest}`,secret,now-301000)).toBe(false);
  expect(verifyScribeSignature(raw,`t=1700000000,t=1700000000,v0=${digest}`,secret,now)).toBe(false);
  expect(verifyScribeSignature(raw,'t=1700000000,v0=xyz',secret,now)).toBe(false);
 });
 it('sends one async request with explicit webhook and opaque correlation only',async()=>{
  vi.stubEnv('ELEVENLABS_API_KEY','synthetic-key');vi.stubEnv('ELEVENLABS_SCRIBE_WEBHOOK_ID','webhook-test');vi.stubEnv('ELEVENLABS_SCRIBE_WEBHOOK_SECRET',secret);
  const fetch=vi.fn().mockResolvedValue(new Response('{"request_id":"request-test","transcription_id":"transcription-test"}'));vi.stubGlobal('fetch',fetch);
  expect(await submitScribeAsync({sourceUrl:'https://storage.example/private-signed',correlationToken:'correlation-test',multiChannel:true,signal:AbortSignal.timeout(1000)})).toEqual({requestId:'request-test',transcriptionId:'transcription-test'});
  const opts=fetch.mock.calls[0][1];expect(opts.cache).toBe('no-store');expect(opts.redirect).toBe('error');
  expect(opts.body.get('webhook_id')).toBe('webhook-test');expect(opts.body.get('webhook_metadata')).toBe('{"correlation_token":"correlation-test"}');expect(opts.body.get('multichannel_output_style')).toBe('combined');expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('bounds the acknowledgement stream and preserves unknown submission instead of parsing unbounded content',async()=>{
  vi.stubEnv('ELEVENLABS_API_KEY','synthetic-key');vi.stubEnv('ELEVENLABS_SCRIBE_WEBHOOK_ID','test');vi.stubEnv('ELEVENLABS_SCRIBE_WEBHOOK_SECRET',secret);
  let cancelled=false;const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(100001));},cancel(){cancelled=true;}});
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(body)));
  await expect(submitScribeAsync({sourceUrl:'https://storage.example/signed',correlationToken:'test',multiChannel:false,signal:AbortSignal.timeout(1000)})).rejects.toMatchObject({code:'scribe_ack_invalid',ambiguous:true});expect(cancelled).toBe(true);
 });
 it('never automatically retries or exposes a provider body after ambiguous submission',async()=>{
  vi.stubEnv('ELEVENLABS_API_KEY','synthetic-key');vi.stubEnv('ELEVENLABS_SCRIBE_WEBHOOK_ID','test');vi.stubEnv('ELEVENLABS_SCRIBE_WEBHOOK_SECRET',secret);
  const fetch=vi.fn().mockResolvedValue(new Response('private transcript and key',{status:503}));vi.stubGlobal('fetch',fetch);
  await expect(submitScribeAsync({sourceUrl:'https://storage.example/signed',correlationToken:'test',multiChannel:false,signal:AbortSignal.timeout(1000)})).rejects.toMatchObject({code:'scribe_submission_rejected',ambiguous:true,message:'scribe_submission_rejected'});expect(fetch).toHaveBeenCalledTimes(1);
 });
});
