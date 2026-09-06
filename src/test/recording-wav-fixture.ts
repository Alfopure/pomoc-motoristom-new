/** Synthetic silence, with the same RIFF/fmt/data structure as the verified Telnyx PCM captures. */
export function pcmWav(dataBytes: number, channels = 2, sampleRate = 48000, bitsPerSample = 16): Buffer {
  const bytes = Buffer.alloc(44 + dataBytes + dataBytes % 2), blockAlign = channels * bitsPerSample / 8;
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * blockAlign, 28);
  bytes.writeUInt16LE(blockAlign, 32); bytes.writeUInt16LE(bitsPerSample, 34); bytes.write('data', 36); bytes.writeUInt32LE(dataBytes, 40);
  return bytes;
}
