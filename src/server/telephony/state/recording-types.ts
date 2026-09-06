import type { AnnouncementKey } from "@/lib/telephony/announcements";
import type { AppEvent, SessionEvent } from "./types";

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
  barrier?: { action: AppEvent | null; deadlineAt: string; epoch: number } | null;
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
  const meta = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as { recording?: RecordingState; announcement_sequence?: AnnouncementSequence } : {};
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
  if (recording.noticeFailed || recording.error && recording.policy.enabled) return { state: "failed", suppressed };
  return { state: recording.recorders.length || suppressed ? "stopped" : "off", suppressed };
}
