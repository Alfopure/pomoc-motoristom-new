export type AudioHeaderInfo =
  | { container: "wav"; channels: number; sampleRate: number; bitsPerSample: number }
  | { container: "mp3"; channelMode: "stereo" | "joint_stereo" | "dual_channel" | "mono" }
  | { container: "ogg" }
  | { container: "unknown"; firstBytesHex: string };

const MP3_CHANNEL_MODES = ["stereo", "joint_stereo", "dual_channel", "mono"] as const;

// Determines container + channel layout from the first bytes of a recording so the
// transcript pipeline can pick channel-split diarization for stereo files.
export function analyzeAudioHeader(bytes: Uint8Array): AudioHeaderInfo {
  if (isWav(bytes)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    return {
      container: "wav",
      channels: view.getUint16(22, true),
      sampleRate: view.getUint32(24, true),
      bitsPerSample: view.getUint16(34, true),
    };
  }

  if (ascii(bytes, 0, 4) === "OggS") {
    return { container: "ogg" };
  }

  const frameOffset = findMp3FrameSync(bytes);

  if (frameOffset !== -1) {
    const channelModeBits = (bytes[frameOffset + 3] & 0b11000000) >> 6;
    return { container: "mp3", channelMode: MP3_CHANNEL_MODES[channelModeBits] };
  }

  return { container: "unknown", firstBytesHex: hex(bytes.subarray(0, 16)) };
}

function isWav(bytes: Uint8Array) {
  return bytes.length >= 44 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE";
}

function findMp3FrameSync(bytes: Uint8Array) {
  // ID3v2 tags can precede the first frame; skip them before scanning.
  let start = 0;

  if (ascii(bytes, 0, 3) === "ID3" && bytes.length >= 10) {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    start = 10 + size;
  }

  const searchLimit = Math.min(bytes.length - 3, start + 65_536);

  for (let index = start; index < searchLimit; index += 1) {
    if (bytes[index] === 0xff && (bytes[index + 1] & 0xe0) === 0xe0) {
      return index;
    }
  }

  return -1;
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function hex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
