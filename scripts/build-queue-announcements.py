"""Compose existing approved speech + 60 seconds of music; no generation API.

Run from the repository root: FFMPEG=/path/to/ffmpeg python3 scripts/build-queue-announcements.py
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

base = Path("public/telephony")
manifest = json.loads((base / "announcements-v2/manifest.json").read_text())
ffmpeg = os.environ.get("FFMPEG", "ffmpeg")
entries = []
for language in ["sk", "cs", "en", "de"]:
    speech = [next(item for item in manifest if item["key"] == key and item["language"] == language) for key in ["holdReminder", "callbackOffer"]]
    target = base / "announcements-v3" / language / "queueWaiting.mp3"
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(base / speech[0]["file"]), "-i", str(base / speech[1]["file"]),
        "-stream_loop", "-1", "-i", str(base / "announcements-v1/moh.mp3"), "-filter_complex",
        "[0:a]aresample=24000,aformat=channel_layouts=mono[a];[1:a]aresample=24000,aformat=channel_layouts=mono[b];[2:a]atrim=duration=60,asetpts=PTS-STARTPTS,aresample=24000,aformat=channel_layouts=mono[c];[a][b][c]concat=n=3:v=0:a=1[out]",
        "-map", "[out]", "-codec:a", "libmp3lame", "-b:a", "64k", str(target)], check=True)
    probe = subprocess.run([ffmpeg, "-hide_banner", "-i", str(target), "-f", "null", "-"], capture_output=True, text=True, check=True)
    duration = re.search(r"Duration: (\d+):(\d+):([\d.]+)", probe.stderr)
    assert duration
    seconds = int(duration[1]) * 3600 + int(duration[2]) * 60 + float(duration[3])
    entries.append({"file": str(target.relative_to(base)), "key": "queueWaiting", "language": language,
        "text": " ".join(item["text"] for item in speech), "voiceId": speech[0]["voiceId"],
        "durationSeconds": seconds, "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
        "assetOrigin": "composed_existing_announcements_and_music", "bytes": target.stat().st_size,
        "sampleRate": 24000, "channels": 1, "runtimeStatus": "active"})
(base / "announcements-v3/manifest.json").write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n")
