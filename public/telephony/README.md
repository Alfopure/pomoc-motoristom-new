# Telephony prompt assets

The current catalogue has 25 prompts in Slovak, Czech, English and German,
plus a 22-second instrumental hold loop: 101 files. The complete release manifest
is `announcements-v2/manifest.json`, including exact copy, runtime status,
duration, sample rate and SHA-256 checksums. Seven original prompts per language
and the music retain their v1 paths; 18 additional prompts per language use v2 paths.
Runtime integrates 19 situations; six optional alternatives remain prepared.

All spoken assets use ElevenLabs Multilingual v2 and Sarah. The retained v1
assets are mono 24 kHz MP3 at 64 kb/s, normalized to -18 LUFS. New v2 recordings
are mono 44.1 kHz MP3. The hold loop was generated with ElevenLabs Sound Effects
v2 and normalized to -25 LUFS; it contains no speech. The original 97 files were
decoded in Chrome; the 68 new recordings were also checked by transcription.

The original filenames remain Slovak aliases for existing media URLs. Runtime
uses the versioned filenames to avoid stale provider caches. Original spoken
hold audio has been replaced by the instrumental loop.

The v2 catalogue integrates hold, transfer, consultation, parking, conference
and outbound announcements. Separate editable service-only and quality recording notices, confirmed stop and resumption
are integrated behind the separate recording policy and provider proof gates.
Six optional alternatives remain prepared, as recorded by runtimeStatus.
Saving or generating clips does not enable recording or prepared alternatives.
`announcements-v2/{language}/recordingNotice.mp3` replaces the old notice draft;
it mentions assistance and quality control. Capture requires completed notice,
approved policy and verified provider capabilities. Uncertain capture never
unlocks private consultation or plays a false confirmation of stopped recording.
Legacy v1 files remain available
for existing URLs. See
`docs/operations/call-announcements.md` for privacy requirements and operation.

Text changes, language selection, previews and new voice generation are in
Settings → Telefonovanie → Hlášky a jazyk. Existing custom IVR prompts retain
precedence. Generated variants are immutable objects in this copy's Supabase
`motorist-telephony-prompts` bucket; bundled MP3s do not need an ElevenLabs key.
