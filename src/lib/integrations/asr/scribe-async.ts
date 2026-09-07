import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

export class ScribeAsyncError extends Error {
  constructor(readonly code: string, readonly ambiguous = false) { super(code); this.name = "ScribeAsyncError"; }
}
export function scribeAsyncConfigured() {
  return Boolean(process.env.ELEVENLABS_API_KEY?.trim() && process.env.ELEVENLABS_SCRIBE_WEBHOOK_ID?.trim() && process.env.ELEVENLABS_SCRIBE_WEBHOOK_SECRET?.trim());
}
export function verifyScribeSignature(raw: string, signature: string | null, secret: string, now = Date.now()) {
  if (!secret || !signature || Buffer.byteLength(raw) > 4_000_000) return false;
  const parts = signature.split(',').map(s => s.trim());
  const timestamps = parts.filter(s => s.startsWith('t='));
  if (timestamps.length !== 1 || !/^t=\d+$/.test(timestamps[0])) return false;
  const timestamp = timestamps[0].slice(2);
  if (!Number.isSafeInteger(Number(timestamp)) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest();
  return parts.filter(s => /^v0=[0-9a-f]{64}$/i.test(s)).some(s => timingSafeEqual(expected, Buffer.from(s.slice(3), 'hex')));
}
async function boundedScribeAck(response: Response) {
 const reader=response.body?.getReader();if(!reader)throw new ScribeAsyncError('scribe_ack_invalid',true);
 const chunks:Uint8Array[]=[];let size=0;
 try {while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>100_000){await reader.cancel();throw new ScribeAsyncError('scribe_ack_invalid',true);}chunks.push(value);}}finally{reader.releaseLock();}
 return Buffer.concat(chunks).toString('utf8');
}
export async function submitScribeAsync(input: { sourceUrl: string; correlationToken: string; multiChannel: boolean; signal: AbortSignal }) {
  if (!scribeAsyncConfigured()) throw new ScribeAsyncError('scribe_not_configured');
  const form = new FormData();
  form.set('model_id', 'scribe_v2'); form.set('source_url', input.sourceUrl);
  form.set('webhook', 'true'); form.set('webhook_id', process.env.ELEVENLABS_SCRIBE_WEBHOOK_ID!.trim());
  form.set('webhook_metadata', JSON.stringify({ correlation_token: input.correlationToken }));
  form.set('timestamps_granularity', 'word'); form.set('tag_audio_events', 'true');
  form.set('diarize', input.multiChannel ? 'false' : 'true');
  form.set('use_multi_channel', input.multiChannel ? 'true' : 'false');
  // Scribe currently rejects combined multichannel output with webhook delivery.
  if (input.multiChannel) form.set('multichannel_output_style', 'separate');
  // enable_logging=false requires an account-level zero-retention entitlement.
  // No retries: a missing acknowledgement must be reconciled, never resubmitted.
  try {
    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY!.trim() }, body: form, signal: input.signal, cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw new ScribeAsyncError('scribe_submission_rejected', response.status >= 500 || response.status === 408);
    const raw = await boundedScribeAck(response);
    if (raw.length > 100_000) throw new ScribeAsyncError('scribe_ack_invalid', true);
    const data = JSON.parse(raw) as { request_id?: unknown; transcription_id?: unknown };
    if (typeof data.request_id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(data.request_id)) throw new ScribeAsyncError('scribe_ack_invalid', true);
    return { requestId: data.request_id, transcriptionId: typeof data.transcription_id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(data.transcription_id) ? data.transcription_id : null };
  } catch (error) {
    if (error instanceof ScribeAsyncError) throw error;
    throw new ScribeAsyncError('scribe_submission_unknown', true);
  }
}
export async function deleteScribeTranscript(id: string, signal: AbortSignal) {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new ScribeAsyncError('scribe_not_configured');
  const response = await fetch(`https://api.elevenlabs.io/v1/speech-to-text/transcripts/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'xi-api-key': key }, signal, cache: 'no-store', redirect: 'error' });
  if (!response.ok && response.status !== 404) throw new ScribeAsyncError('scribe_delete_unconfirmed');
}
