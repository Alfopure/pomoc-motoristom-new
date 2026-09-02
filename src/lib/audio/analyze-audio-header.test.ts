import { describe, expect, it } from "vitest";

import { analyzeAudioHeader } from "./analyze-audio-header";

function wavHeader({ channels, sampleRate, bitsPerSample }: { channels: number; sampleRate: number; bitsPerSample: number }) {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint16(34, bitsPerSample, true);
  return bytes;
}

describe("analyzeAudioHeader", () => {
  it("parses a stereo 8kHz wav header", () => {
    const info = analyzeAudioHeader(wavHeader({ channels: 2, sampleRate: 8000, bitsPerSample: 16 }));
    expect(info).toEqual({ container: "wav", channels: 2, sampleRate: 8000, bitsPerSample: 16 });
  });

  it("parses a mono wav header", () => {
    const info = analyzeAudioHeader(wavHeader({ channels: 1, sampleRate: 8000, bitsPerSample: 16 }));
    expect(info).toMatchObject({ container: "wav", channels: 1 });
  });

  it("detects mp3 mono channel mode from the frame header", () => {
    // 0xFF 0xFB frame sync; byte 3 top bits 11 => mono
    const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0xc0, 0x00, 0x00, 0x00, 0x00]);
    expect(analyzeAudioHeader(bytes)).toEqual({ container: "mp3", channelMode: "mono" });
  });

  it("detects mp3 stereo channel mode behind an ID3v2 tag", () => {
    const tagBody = 6;
    const bytes = new Uint8Array(10 + tagBody + 4);
    bytes.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, tagBody], 0); // ID3 header, size=6
    bytes.set([0xff, 0xfb, 0x90, 0x00], 10 + tagBody); // frame header, channel bits 00 => stereo
    expect(analyzeAudioHeader(bytes)).toEqual({ container: "mp3", channelMode: "stereo" });
  });

  it("detects ogg", () => {
    const bytes = new Uint8Array(48);
    bytes.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
    expect(analyzeAudioHeader(bytes)).toEqual({ container: "ogg" });
  });

  it("falls back to unknown with hex preview", () => {
    const info = analyzeAudioHeader(new Uint8Array([0x00, 0x01, 0x02]));
    expect(info.container).toBe("unknown");
  });
});
