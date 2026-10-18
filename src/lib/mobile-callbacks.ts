import type { MobileDraftScope, MobileScope } from "./mobile-api";

/** Provider-neutral view of `motorist_callback_requests` for the native client. */
export type MobileCallbackOrigin = "requested" | "missed" | "manual" | "unknown";
export type MobileCallbackStatus = "open" | "scheduled" | "done" | "cancelled";
export type MobileCallbackActions = {
  /** Take a free request, or take one over from a colleague (`takeover`). */
  claim: boolean;
  takeover: boolean;
  call: boolean;
  resolve: boolean;
  blockedReason: string | null;
};
export type MobileCallbackRequest = {
  id: string;
  /** Null when the stored caller number is missing or not a dialable value. */
  number: string | null;
  name: string | null;
  status: MobileCallbackStatus;
  origin: MobileCallbackOrigin;
  /** Caller's recorded choice ("Volajúci stlačil 1 · počas čakania"); null without evidence. */
  originDetail: string | null;
  sourceLabel: string;
  lineLabel: string | null;
  partnerName: string | null;
  caseId: string | null;
  claimant: { id: string; name: string | null; mine: boolean } | null;
  claimedAt: string | null;
  /** Promise to the caller: stored due time, otherwise creation + 30 minutes. */
  deadlineAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
  notes: string | null;
  lastCalledAt: string | null;
  actions: MobileCallbackActions;
};
export type MobileCallbackCounts = {
  open: number;
  requested: number;
  missed: number;
  manual: number;
  unknown: number;
};
/** Independent exact counts, not one transaction-wide snapshot. */
export type MobileCallbackSummary = MobileScope & {
  counts: MobileCallbackCounts & { mine: number; unclaimed: number; overdue: number };
};
export type MobileCallbacks = MobileDraftScope & {
  counts: MobileCallbackCounts;
  /** Priority order: confirmed caller requests first, then other unresolved calls. */
  open: MobileCallbackRequest[];
  /** Closed in the last 24 hours, newest first; context, not a work list. */
  resolved: MobileCallbackRequest[];
  nextCursor: string | null;
  /** The queue changed under the supplied cursor; reload from the first page. */
  resetPage: boolean;
};
export type MobileCallbackResolveInput = { status: "done" | "cancelled"; notes: string | null };
export type MobileCallbackChanged = MobileDraftScope & { request: MobileCallbackRequest };

/** Directory decision for dialing a number; the server revalidates before any call. */
export type MobileCallTarget = MobileScope & {
  target: {
    status: "original" | "verified_alternative" | "blocked";
    originalNumber: string;
    dialNumber: string | null;
    sourceName: string | null;
    targetName: string | null;
    verificationId: string | null;
  };
};

export const MOBILE_CALLBACK_NOTE_LIMIT = 500;
