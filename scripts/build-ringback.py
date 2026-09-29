#!/usr/bin/env python3
"""Build the caller's ringing tone without runtime or Python package dependencies.

Run: python3 scripts/build-ringback.py --ffmpeg /path/to/ffmpeg
The checked-in MP3 is served directly from public/telephony/tones-v1/.

The 425 Hz, 1 second on / 4 seconds off cadence follows the Slovak and Czech
ringing tones in ITU Operational Bulletin 781 (2003), pages 23 and 9:
https://www.itu.int/ITU-T/inr/forms/files/tones-0203.pdf
Six cycles keep provider playback loops infrequent. Short fades avoid clicks.
"""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import wave


SAMPLE_RATE = 16_000
FREQUENCY_HZ = 425
TONE_SECONDS = 1
CYCLE_SECONDS = 5
CYCLES = 6
FADE_SECONDS = 0.01
PEAK = 0.25
OUTPUT = Path(__file__).resolve().parent.parent / "public/telephony/tones-v1/ringback.mp3"


def build_pcm():
    tone_frames = TONE_SECONDS * SAMPLE_RATE
    cycle_frames = CYCLE_SECONDS * SAMPLE_RATE
    fade_frames = round(FADE_SECONDS * SAMPLE_RATE)
    cycle = bytearray(cycle_frames * 2)
    for frame in range(tone_frames):
        # Both endpoints are exactly zero; the rest of each cycle is silence.
        edge = min(frame, tone_frames - 1 - frame, fade_frames) / fade_frames
        envelope = 0.5 - 0.5 * math.cos(math.pi * edge)
        sample = round(32767 * PEAK * envelope * math.sin(2 * math.pi * FREQUENCY_HZ * frame / SAMPLE_RATE))
        struct.pack_into("<h", cycle, frame * 2, sample)
    return cycle * CYCLES


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", default=os.environ.get("FFMPEG", "ffmpeg"), help="ffmpeg executable with the libmp3lame encoder")
    parser.add_argument("--output", type=Path, default=OUTPUT, help="destination MP3 path")
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ringback-") as temporary:
        source = Path(temporary) / "ringback.wav"
        with wave.open(str(source), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            wav.writeframes(build_pcm())
        subprocess.run([
            args.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(source), "-map_metadata", "-1",
            "-fflags", "+bitexact", "-flags:a", "+bitexact",
            "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "libmp3lame", "-b:a", "32k",
            "-id3v2_version", "0", "-write_id3v1", "0", str(args.output),
        ], check=True)
    data = args.output.read_bytes()
    print(json.dumps({
        "file": str(args.output),
        "durationSeconds": CYCLE_SECONDS * CYCLES,
        "sampleRate": SAMPLE_RATE,
        "channels": 1,
        "bitrateKbps": 32,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }, indent=2))


if __name__ == "__main__":
    main()
