import type { AnnouncementKey } from "@/lib/telephony/announcements";
import type { AppEvent, Command, SessionEvent } from "./types";

/** Live marker probes found immediate record_start → bridge can truncate media. */
export const RECORDING_START_SETTLE_MS = 600;

/** enabled is resolved on the server from approved policy AND both provider proof gates. */
export type RecordingRoutingPolicy = {
  enabled: boolean;
  inbound: boolean;
  outbound: boolean;
  policyId: string | null;
  noticeVersion: string;
  maxSegmentSeconds: number;
  qualityEnabled?: boolean;
  reason?: string;
  conferenceVerified?: boolean;
  transferVerified?: boolean;
  channelMappingVerified?: boolean;
};

export type RecorderState = {
  id: string;
  epoch: number;
  callControlId: string;
  startCommandId: string;
  providerRecordingId?: string | null;
  stopCommandId?: string;
  desired: "recording" | "stopped";
  observed: "starting" | "recording" | "stopping" | "stopped" | "unknown";
  startedAt: string | null;
  stoppedAt: string | null;
  error: string | null;
};

export type RecordingState = {
  version: 1;
  policy: RecordingRoutingPolicy;
  epoch: number;
  noticeCompletedAt: string | null;
  noticeFailed: boolean;
  notifiedCallControlIds?: string[];
  suppressedAt: string | null;
  suppressionReason: "objection" | "topology" | null;
  recorders: RecorderState[];
  error: string | null;
  /** Audio was released before START was confirmed. Later acknowledgements cannot prove that earlier coverage. */
  coverageUnconfirmed?: { since: string; epoch: number; audioCommandId: string };
  barrier?: { action: AppEvent | null; deadlineAt: string; epoch: number } | null;
  pendingAudio?: { epoch: number; startedAt?: string; readyAt: string; sourceEventId: string; operatorProfileId?: string | null; conferenceId?: string | null;
    commands: Array<Extract<Command, { kind: "bridge" | "conference_unhold" | "conference_join" }>> } | null;
  /** confirmedAt is set only after both parties have verified joined membership. */
  connection?: { commandId: string; epoch: number; startedAt: string; confirmedAt: string | null; conferenceId: string | null;
    operatorProfileId: string | null; callControlIds: string[] } | null;
};

/** A bounded, resumable customer-only announcement. Provider completion is mandatory. */
export type AnnouncementSequence = {
  id: string;
  keys: AnnouncementKey[];
  index: number;
  callControlId: string;
  startedAt: string;
  deadlineAt: string;
  speechRetry: boolean;
  continuation: SessionEvent | null;
};

export function summarizeSessionRecording(metadata: unknown): { state: "off" | "notice" | "starting" | "recording" | "stopping" | "stopped" | "failed" | "unknown"; suppressed: boolean } {
  const meta = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as { recording?: RecordingState; announcement_sequence?: AnnouncementSequence;
    greeting?: { recording_notice?: string; completed_at?: string } } : {};
  const recording = meta.recording;
  const suppressed = recording?.suppressionReason === "objection";
  if (!recording || !Array.isArray(recording.recorders)) return { state: "off", suppressed: false };
  const states = recording.recorders.map((recorder) => recorder.observed);
  if (states.includes("unknown")) return { state: "unknown", suppressed };
  if (states.includes("stopping")) return { state: "stopping", suppressed };
  if (states.includes("starting")) return { state: "starting", suppressed };
  if (states.includes("recording")) return { state: "recording", suppressed };
  const pendingNotice = meta.announcement_sequence?.keys[meta.announcement_sequence.index];
  if (pendingNotice === "recordingNotice" || pendingNotice === "recordingServiceNotice") return { state: "notice", suppressed };
  if (meta.greeting?.recording_notice && !meta.greeting.completed_at && !recording.noticeFailed) return { state: "notice", suppressed };
  if (recording.noticeFailed || recording.error && recording.policy.enabled) return { state: "failed", suppressed };
  return { state: recording.recorders.length || suppressed ? "stopped" : "off", suppressed };
}
