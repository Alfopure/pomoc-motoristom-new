# Telephony prompt assets

The current v4 catalogue has 26 prompts in Slovak, Czech, English and German,
plus instrumental hold music: 105 files. `announcements-v4/manifest.json`
contains the exact text, voice, duration, runtime status and SHA-256 of every
current asset. Twenty situations are integrated; six optional alternatives
remain explicitly prepared. All new speech uses new v4 URLs to bypass stale
provider media caches. Earlier assets remain available for existing URLs.

The default voice is Richard, a native Slovak professional voice from the
ElevenLabs library. The model is Multilingual v2; the preset uses stability
0.4, similarity 0.75, speed 1.1 and no speaker boost. Spoken recordings are
mono 24 kHz MP3 at 64 kb/s, normalized to -18 LUFS with a -2 dBTP target.
Only edge silence is trimmed; pauses within speech are retained.

The existing instrumental hold loop stays at `announcements-v1/moh.mp3`.
`queueWaiting.mp3` combines the new wait reminder and callback offer with
60 seconds of that music. Rebuild it with `scripts/build-queue-announcements.py`.
No new music or paid generation is needed to compose the queue asset.

Recording notices use generic company wording, the actual service/quality
purpose and a short dispatcher contact/objection pointer. The opening greeting
identifies the service; the public `/ochrana-hovorov` page and dispatcher provide
the full controller identity, AI processing, retention and rights information.
This is layered information, not a claim that one universal legal sentence exists.

Text, language, voice, previews and regeneration are in Settings → Telefonovanie
→ Hlášky a jazyk. Richard and Jolana are the new Slovak voice choices; Sarah and
Daniel remain available for existing settings. Their original generation presets
are preserved so existing immutable generated audio remains valid when saving.
Custom text is not automatically translated. Existing custom IVR media retains
precedence. Generated audio stays in this copy's public prompt bucket; customer
recordings use the separate private recording storage.

Saving or generating announcements does not activate recording or optional
situations. Notice completion, recording approval and the existing privacy
barriers continue to control actual capture.
