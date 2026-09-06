# Telephony prompt assets

The current catalogue has 24 prompts in Slovak, Czech, English and German,
plus a 22-second instrumental hold loop: 97 files. The complete release manifest
is `announcements-v2/manifest.json`, including exact copy, runtime status,
duration, sample rate and SHA-256 checksums. Seven active prompts per language
and the music retain their v1 paths; 17 prepared prompts per language use v2 paths.

All spoken assets use ElevenLabs Multilingual v2 and Sarah. The retained v1
assets are mono 24 kHz MP3 at 64 kb/s, normalized to -18 LUFS. New v2 recordings
are mono 44.1 kHz MP3. The hold loop was generated with ElevenLabs Sound Effects
v2 and normalized to -25 LUFS; it contains no speech. All 97 current files were
decoded in Chrome; the 68 new recordings were also checked by transcription.

The original filenames remain Slovak aliases for existing media URLs. Runtime
uses the versioned filenames to avoid stale provider caches. Original spoken
hold audio has been replaced by the instrumental loop.

The v2 catalogue includes hold, transfer, consultation, parking, conference,
outbound and recording-state announcements as prepared, inactive content.
Saving or generating these clips does not activate a call-flow feature.
`announcements-v2/{language}/recordingNotice.mp3` replaces the old notice draft;
it mentions assistance and quality control. The app does not start call
recording or automatically play either notice. Legacy v1 files remain available
for existing URLs. See
`docs/operations/call-announcements.md` for privacy requirements and operation.

Text changes, language selection, previews and new voice generation are in
Settings → Telefonovanie → Hlášky a jazyk. Existing custom IVR prompts retain
precedence. Generated variants are immutable objects in this copy's Supabase
`motorist-telephony-prompts` bucket; bundled MP3s do not need an ElevenLabs key.
