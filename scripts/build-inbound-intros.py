"""Compose the exact bundled welcome + approved recording notice, without APIs.

Run at repository root: FFMPEG=/path/to/ffmpeg python3 scripts/build-inbound-intros.py
Custom voices/text are intentionally excluded. New source speech requires a new
asset version and matching resolver before replacing these immutable URLs.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

base = Path("public/telephony")
source = json.loads((base / "announcements-v4/manifest.json").read_text())
ffmpeg = os.environ.get("FFMPEG", "ffmpeg")
entries = []
for language in ["sk", "cs", "en", "de"]:
    for notice in ["recordingServiceNotice", "recordingNotice"]:
        clips = [next(item for item in source if item["key"] == key and item["language"] == language) for key in ["greeting", notice]]
        assert clips[0]["voiceId"] == clips[1]["voiceId"]
        for clip in clips:
            assert hashlib.sha256((base / clip["file"]).read_bytes()).hexdigest() == clip["sha256"]
        target = base / "announcements-intro-v1" / language / f"greeting-{notice}.mp3"
        target.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(base / clips[0]["file"]), "-i", str(base / clips[1]["file"]),
            "-filter_complex", "[0:a]aresample=24000,aformat=channel_layouts=mono[a];[1:a]aresample=24000,aformat=channel_layouts=mono[b];[a][b]concat=n=2:v=0:a=1[out]",
            "-map", "[out]", "-codec:a", "libmp3lame", "-b:a", "64k", str(target)], check=True)
        probe = subprocess.run([ffmpeg, "-hide_banner", "-i", str(target), "-f", "null", "-"], capture_output=True, text=True, check=True)
        duration = re.search(r"Duration: (\d+):(\d+):([\d.]+)", probe.stderr)
        assert duration
        seconds = int(duration[1]) * 3600 + int(duration[2]) * 60 + float(duration[3])
        entries.append({"file": str(target.relative_to(base)), "language": language, "notice": notice,
            "text": " ".join(item["text"] for item in clips), "voiceId": clips[0]["voiceId"], "durationSeconds": seconds,
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest(), "bytes": target.stat().st_size,
            "assetOrigin": "composed_existing_approved_speech", "sourceFiles": [{"file": item["file"], "sha256": item["sha256"]} for item in clips],
            "sampleRate": 24000, "channels": 1})
(base / "announcements-intro-v1/manifest.json").write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n")
