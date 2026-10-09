/** Closed mapping verified against @telnyx/webrtc 2.27.10 SDK_WARNINGS.
 * Keep provider messages, stats, addresses and SDP out of diagnostic events. */
export const VOICE_QUALITY_WARNINGS = [
  { code: 31001, reason: "sdk_high_rtt", label: "Vyššie oneskorenie siete", silence: false, local: false },
  { code: 31002, reason: "sdk_high_jitter", label: "Kolísanie oneskorenia siete", silence: false, local: false },
  { code: 31003, reason: "sdk_high_packet_loss", label: "Strata zvukových paketov", silence: false, local: false },
  { code: 31004, reason: "sdk_low_mos", label: "Nižší odhad kvality spojenia", silence: false, local: false },
  { code: 31005, reason: "sdk_low_local_audio", label: "Nízka úroveň mikrofónu", silence: true, local: true },
  { code: 31006, reason: "sdk_low_inbound_audio", label: "Nízka úroveň prijímaného zvuku", silence: true, local: false },
  { code: 32001, reason: "sdk_low_bytes_received", label: "Chýbajúce prijímané zvukové dáta", silence: true, local: false },
  { code: 32002, reason: "sdk_low_bytes_sent", label: "Chýbajúce odosielané zvukové dáta", silence: true, local: true },
] as const;

export type VoiceQualityWarning = typeof VOICE_QUALITY_WARNINGS[number];
export type VoiceQualityWarningCode = VoiceQualityWarning["code"];

export function voiceQualityWarning(code: unknown): VoiceQualityWarning | undefined {
  return VOICE_QUALITY_WARNINGS.find(warning => warning.code === code);
}

export function expectedVoiceSilence(warning: VoiceQualityWarning, held: boolean, muted: boolean): boolean {
  return warning.silence && (held || warning.local && muted);
}
