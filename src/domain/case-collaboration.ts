import type { CaseDetailData } from "@/data/case-detail";
import type { DispatchNotification } from "./types";

export const CASE_ACL_LEASE_MS = 30_000;
export const CASE_REVALIDATE_MS = 25_000;
export const EDITOR_HEARTBEAT_MS = 15_000;
export const EDITOR_TTL_MS = 60_000;
export type CaseEditorPresence = {
  sessionId: string; profileId: string; displayName: string;
  caseId: string | null; draftId: string | null; expiresAt: string;
};
export type CaseLiveSnapshot = {
  available: boolean; ids: string[]; changes: CaseDetailData[];
  versions: Record<string, number>; more: boolean;
  notifications: DispatchNotification[]; editors: CaseEditorPresence[];
};
/** Multiple browser sessions stay independent; their human-facing names do not duplicate. */
export function activeCaseEditors(entries: CaseEditorPresence[], now: number, caseId: string | null, viewer?: string) {
  return [...new Map(entries.filter(entry => Date.parse(entry.expiresAt) > now && entry.caseId === caseId && entry.profileId !== viewer)
    .map(entry => [entry.profileId, entry])).values()];
}
