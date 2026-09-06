import "server-only";
import type { Json } from '@/lib/supabase/database.types';
import { record, RecordingProcessingError } from './recording-jobs';

const HEADER_LIMIT = 6 * 1024 * 1024;
export type RecordingAudioIntegrity = {
  version: 1; source: 'riff_pcm_v1'; totalBytes: number; dataOffset: number; dataBytes: number;
  audioDurationSeconds: number; audioFormat: { sampleRate: number; channels: number; bitsPerSample: number };
};
/** Parse only the first bounded download chunk; RIFF sizes are checked against the verified HTTP total. */
export function inspectRecordingWav(chunk: Buffer, totalBytes: number): RecordingAudioIntegrity {
  const bytes = chunk.subarray(0, HEADER_LIMIT);
  const invalid = (code = 'wav_structure_invalid'): never => { throw new RecordingProcessingError(code); };
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 44 || totalBytes > 134217728 || bytes.length < 12
    || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== totalBytes) return invalid();
  let format: { sampleRate: number; channels: number; bitsPerSample: number; blockAlign: number } | null = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', at, at + 4), size = bytes.readUInt32LE(at + 4), dataOffset = at + 8;
    const end = dataOffset + size, next = end + size % 2;
    if (end > totalBytes || next > totalBytes) return invalid();
    if (name === 'fmt ') {
      if (format || size < 16 || end > bytes.length) return invalid();
      const tag = bytes.readUInt16LE(dataOffset), channels = bytes.readUInt16LE(dataOffset + 2), sampleRate = bytes.readUInt32LE(dataOffset + 4);
      const byteRate = bytes.readUInt32LE(dataOffset + 8), blockAlign = bytes.readUInt16LE(dataOffset + 12), bitsPerSample = bytes.readUInt16LE(dataOffset + 14);
      // The verified Telnyx contract is integer PCM. Other codecs must not inherit its duration formula.
      if (tag !== 1) return invalid('wav_codec_unsupported');
      if (channels < 1 || channels > 8 || sampleRate < 1 || sampleRate > 384000 || ![8, 16, 24, 32].includes(bitsPerSample)
        || blockAlign !== channels * bitsPerSample / 8 || byteRate !== sampleRate * blockAlign) return invalid();
      format = { sampleRate, channels, bitsPerSample, blockAlign };
    } else if (name === 'data') {
      if (!format || size < 1 || size % format.blockAlign !== 0) return invalid();
      // This pilot accepts a single terminal PCM data chunk; extra payload requires a separately verified container contract.
      if (next !== totalBytes) return invalid();
      return { version: 1, source: 'riff_pcm_v1', totalBytes, dataOffset, dataBytes: size,
        audioDurationSeconds: size / (format.sampleRate * format.blockAlign),
        audioFormat: { sampleRate: format.sampleRate, channels: format.channels, bitsPerSample: format.bitsPerSample } };
    }
    if (next > bytes.length) return invalid('wav_header_limit');
    at = next;
  }
  return invalid('wav_header_limit');
}

/** Topology refresh can improve participant evidence, but cannot replace independently measured audio provenance. */
export function preserveRecordingAudioProvenance(existing: Json, refreshed: Json): Json {
  const previous = record(existing), next = record(refreshed);
  const measured = typeof previous.audioDurationSeconds === 'number' && Number.isFinite(previous.audioDurationSeconds) && previous.audioDurationSeconds > 0;
  const timingVerified = measured && previous.timingVerified === true;
  return { ...next, audioDurationSeconds: measured ? previous.audioDurationSeconds! : null,
    audioFormat: previous.audioFormat ?? null, timingVerified, timingDriftSeconds: previous.timingDriftSeconds ?? null,
    timingWarning: previous.timingWarning ?? (timingVerified ? null : 'audio_duration_unverified'),
    ...(!timingVerified ? { openingComplete: false, conversationComplete: false, closingComplete: false } : {}) };
}
