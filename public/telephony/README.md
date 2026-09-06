# Telephony prompt assets

Caller announcements live in `announcements-v1/{sk,cs,en,de}/`, with a manifest of
exact copy, duration and SHA-256 checksums. All 32 spoken assets use ElevenLabs
Multilingual v2, Sarah, stable delivery at speed 1.05, normalized to -18 LUFS,
mono 24 kHz MP3 at 64 kb/s. The 22-second instrumental hold loop is generated with
ElevenLabs Sound Effects v2 and normalized to -25 LUFS. It contains no speech.

The original filenames remain Slovak aliases for existing media URLs. Runtime
uses the versioned filenames to avoid stale provider caches. Original spoken
hold audio has been replaced by the instrumental loop.

`recording-notice.mp3` is a prepared template only: the app does not start call
recording and does not automatically play that notice. See
`docs/operations/call-announcements.md` for privacy requirements and operation.

Text changes, language selection, previews and new voice generation are in
Settings → Telefonovanie → Hlášky a jazyk. Existing custom IVR prompts retain
precedence. Generated variants are immutable objects in this copy's Supabase
`motorist-telephony-prompts` bucket; bundled MP3s do not need an ElevenLabs key.
