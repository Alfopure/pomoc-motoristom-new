import type { CallRecordingDetail, QualityVerdict, RecordingContentState, RecordingLiveState } from "@/lib/telephony/recording-quality";

export const CONTENT_LABELS: Record<RecordingContentState, string> = {
  disabled: "Vypnuté", pending: "Čaká na spracovanie", processing: "Spracúva sa", ready: "Pripravené", partial: "Čiastočný záznam", failed: "Spracovanie zlyhalo", restricted: "Prístup obmedzený", deleted: "Záznam odstránený",
};
export const LIVE_LABELS: Record<RecordingLiveState, string> = {
  off: "Nenahráva sa", notice: "Prehráva sa oznámenie", starting: "Nahrávanie sa spúšťa", recording: "Nahrávanie prebieha", stopping: "Čaká sa na potvrdenie zastavenia", stopped: "Nahrávanie zastavené", failed: "Nahrávanie zlyhalo", unknown: "Stav nahrávania nepotvrdený",
};
export const VERDICT_LABELS: Record<QualityVerdict, string> = {
  met: "Splnené", partial: "Čiastočne", not_met: "Nesplnené", not_applicable: "Nevzťahuje sa", unknown: "Nedostatok podkladov",
};

export function canShowRecordingContent(detail: Pick<CallRecordingDetail, "access" | "state">): boolean {
  return detail.access === "full" && !["restricted", "deleted", "disabled"].includes(detail.state);
}

export function playbackTarget(detail: Pick<CallRecordingDetail, "access" | "state" | "segments" | "gaps">, seconds: number, segmentId?: string) {
  if (!canShowRecordingContent(detail) || !Number.isFinite(seconds) || seconds < 0) return null;
  if (detail.gaps.some((gap) => seconds >= gap.startSeconds && seconds < gap.endSeconds)) return null;
  const segment = detail.segments.find((item) => (!segmentId || item.id === segmentId) && item.canPlay && (item.state === "ready" || item.state === "partial") && Number.isFinite(item.startSeconds) && Number.isFinite(item.durationSeconds) && item.durationSeconds > 0 && seconds >= item.startSeconds && seconds < item.startSeconds + item.durationSeconds);
  return segment ? { segment, offsetSeconds: seconds - segment.startSeconds } : null;
}

/** A stored file can be playable even when its coverage on the call timeline is unverified. */
export function playbackSegmentTarget(detail: Pick<CallRecordingDetail, "access" | "state" | "segments">, segmentId: string) {
  if (!canShowRecordingContent(detail)) return null;
  const segment = detail.segments.find((item) => item.id === segmentId && item.canPlay && (item.state === "ready" || item.state === "partial")
    && Number.isFinite(item.durationSeconds) && item.durationSeconds > 0);
  return segment ? { segment, offsetSeconds: 0 } : null;
}

export function qualityPercent(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) || value < 0 || value > 1 ? "—" : `${Math.round(value * 100)} %`;
}
