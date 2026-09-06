/** Public recording/quality contract. No provider URLs, credentials or raw payloads. */
export const QUALITY_RUBRIC_VERSION = "motorist-quality-v1";
export const QUALITY_CRITERIA = [
  { id: "greeting", label: "Pozdrav a predstavenie", weight: 10, critical: false },
  { id: "discovery", label: "Zistenie potrebných údajov", weight: 20, critical: true },
  { id: "understanding", label: "Pochopenie potreby", weight: 15, critical: true },
  { id: "next_step", label: "Riešenie a ďalší postup", weight: 25, critical: true },
  { id: "clarity", label: "Zrozumiteľná komunikácia", weight: 15, critical: false },
  { id: "hold_transfer", label: "Podržanie a odovzdanie", weight: 10, critical: false },
  { id: "closing", label: "Ukončenie", weight: 5, critical: false },
] as const;

export type QualityCriterionId = (typeof QUALITY_CRITERIA)[number]["id"];
export type QualityVerdict = "met" | "partial" | "not_met" | "not_applicable" | "unknown";
export type RecordingContentState = "disabled" | "pending" | "processing" | "ready" | "partial" | "failed" | "restricted" | "deleted";
export type RecordingLiveState = "off" | "notice" | "starting" | "recording" | "stopping" | "stopped" | "failed" | "unknown";
export type RecordingLanguage = "sk" | "cs" | "en" | "de";

export type RecordingTranscriptSpan = {
  id: string;
  transcriptId: string;
  segmentId: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
  speakerLabel: string;
  role: "operator" | "customer" | "unknown" | "system";
  operatorId: string | null;
  identityVerified: boolean;
};

export type QualityEvidence = Pick<RecordingTranscriptSpan, "id" | "segmentId" | "startSeconds" | "endSeconds" | "text" | "speakerLabel" | "operatorId">;
export type QualityCriterion = {
  id: QualityCriterionId;
  verdict: QualityVerdict;
  reason: string;
  evidence: QualityEvidence[];
  absenceWindow: "opening" | "conversation" | "closing" | null;
  applicabilityReason: string | null;
  uncertaintyReason: string | null;
};
export type QualityReview = {
  id: string;
  status: "approved" | "rejected" | "stale";
  reviewerName: string;
  reviewedAt: string;
  note: string;
  score: number | null;
  coverage: number;
  criteria: QualityCriterion[];
};
export type OperatorQualityEvaluation = {
  /** Owner of an older effective approval when a newer AI draft also exists. */
  analysisId?: string;
  operatorId: string;
  operatorName: string;
  rubricVersion: string;
  criteria: QualityCriterion[];
  score: number | null;
  coverage: number;
  eligibilityReasons: string[];
  coaching: string[];
  review: QualityReview | null;
  /** Estimates for this verified operator's intervals; not a quality score. */
  speechSeconds?: number | null;
  speechShare?: number | null;
  connectedSeconds?: number | null;
};
export type CallAnalysisFact = { label: string; value: string | null; evidence: QualityEvidence[] };
export type CallQualityAnalysis = {
  id: string;
  status: "draft" | "complete" | "failed" | "stale";
  model: string;
  rubricVersion: string;
  createdAt: string;
  topic: string;
  reason: string | null;
  summary: string;
  outcome: "resolved" | "next_step_agreed" | "awaiting_confirmation" | "transferred" | "interrupted" | "unknown";
  facts: CallAnalysisFact[];
  actions: CallAnalysisFact[];
  nextSteps: CallAnalysisFact[];
  operators: OperatorQualityEvaluation[];
  warnings: string[];
};
export type CallCommunicationMetrics = {
  durationSeconds: number;
  connectedSeconds: number;
  holdSeconds: number;
  transferCount: number;
  operatorSpeechSeconds: number | null;
  customerSpeechSeconds: number | null;
  overlapSeconds: number | null;
  silenceSeconds: number | null;
  operatorSpeechShare: number | null;
  estimated: boolean;
};
export type CallRecordingDetail = {
  callId: string;
  sourceRevision: number;
  access: "full" | "own_review" | "restricted";
  state: RecordingContentState;
  stateReason: string | null;
  liveState: RecordingLiveState;
  suppressed: boolean;
  segments: Array<{
    id: string;
    index: number;
    startSeconds: number;
    durationSeconds: number;
    state: RecordingContentState;
    channels: number | null;
    canPlay: boolean;
    error: string | null;
  }>;
  gaps: Array<{ startSeconds: number; endSeconds: number; reason: string }>;
  transcript: { status: RecordingContentState; language: string | null; spans: RecordingTranscriptSpan[] };
  analysis: CallQualityAnalysis | null;
  metrics: CallCommunicationMetrics | null;
  capabilities: { canReview: boolean; canAppeal: boolean; canCorrect: boolean; canDelete: boolean; canControl: boolean; canRetry: boolean };
};

export type RecordingPolicyDocument = {
  revision: number;
  recordingEnabled: boolean;
  transcriptionEnabled: boolean;
  analysisEnabled: boolean;
  qualityEnabled: boolean;
  inboundEnabled: boolean;
  outboundEnabled: boolean;
  audioRetentionDays: number;
  transcriptRetentionDays: number;
  reviewRetentionDays: number;
  maxRecordingsPerHour: number;
  maxRecordingBytes: number;
  maxSegmentSeconds: number;
  controllerName: string;
  contactEmail: string;
  privacyNoticeUrl: string;
  serviceLegalBasis: string;
  qualityLegalBasis: string;
  approvedAt: string | null;
};
export type RecordingPolicyResponse = {
  policy: RecordingPolicyDocument;
  canEdit: boolean;
  readiness: { recording: boolean; transcription: boolean; analysis: boolean; reasons: string[] };
};
export type QualityDashboardResponse = {
  rubricVersion: string;
  page: number;
  pageSize: number;
  total: number;
  totals: { calls: number; approved: number; drafts: number; unscorable: number; failed: number };
  operators: Array<{ operatorId: string; operatorName: string; approvedCalls: number; averageScore: number | null; smallSample: boolean }>;
  trend: Array<{ period: string; approvedCalls: number; averageScore: number | null }>;
  rows: Array<{
    callId: string;
    startedAt: string;
    operatorId: string;
    operatorName: string;
    topic: string;
    language: string | null;
    status: "draft" | "approved" | "stale" | "unscorable";
    score: number | null;
    coverage: number;
  }>;
};

export type QualityReviewInput = {
  analysisId: string;
  operatorId: string;
  sourceRevision: number;
  expectedReviewId: string | null;
  criteria: QualityCriterion[];
  note: string;
};
