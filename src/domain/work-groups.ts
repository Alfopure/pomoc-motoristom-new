/** Pobočky: central → receiving group → local lead → executor. Server RPCs authorize every read and command. */
export type WorkRequestKind = 'delivery' | 'collection' | 'transfer' | 'tow';
export type WorkRequestStatus = 'queued' | 'claimed' | 'assigned' | 'cancelled';
export type BranchView = 'open' | 'queue' | 'active' | 'done' | 'all';
export type BranchAction = 'create' | 'route' | 'claim' | 'release' | 'cancel' | 'materialize' | 'operate' | 'reopen' | 'group_save' | 'group_member';
export interface BranchActor { userId: string; organizationId: string; displayName: string; memberId: string | null; version: number | null; central: boolean; manage: boolean; leadGroups: { id: string; name: string; role: 'lead'; receivesNew: boolean }[]; canDeliver: boolean; canOperateTowing: boolean }
export interface WorkExecution { operationId: string; owner: 'logistics' | 'towing_order'; ownerId: string; status: string; revision: number; assigneeId: string | null; assignee: string | null; scheduledAt: string | null; plannedEndAt: string | null; confirmedAt: string | null; startedAt: string | null; finishedAt: string | null; done: boolean; cancelled: boolean }
export interface WorkRequest { id: string; kind: WorkRequestKind; status: WorkRequestStatus; revision: number; groupId: string; groupName: string; branchName: string | null; caseId: string | null; caseNumber: string | null; caseType: string | null; customer: { name: string; phone: string } | null; vehicle: string | null; pickup: string; destination: string; dueAt: string | null; note: string; fleetAssetId: string | null; cycleId: string | null; routedAt: string; claimedBy: string | null; claimedByName: string | null; claimedAt: string | null; cancelReason: string | null; createdAt: string; updatedAt: string; execution: WorkExecution | null; related: { id: string; kind: WorkRequestKind; status: WorkRequestStatus; groupName: string; executionStatus: string | null }[] }
export interface WorkGroupMember { id: string; name: string; role: 'lead' | 'member'; receivesNew: boolean; active: boolean; canDeliver: boolean; canDrive: boolean }
export interface WorkGroup { id: string; name: string; active: boolean; revision: number; branchId: string | null; branchName: string | null; serviceKinds: WorkRequestKind[]; counts: { queued: number; claimed: number; active: number; overdue: number }; members: WorkGroupMember[] }
export interface BranchWorkspace { actor: BranchActor; requests: WorkRequest[]; totalCount: number; groups: WorkGroup[]; branches: { id: string; name: string }[]; people: { id: string; name: string; email: string | null; roles: string[] }[]; cycles: { id: string; vehicle: string; caseId: string | null }[]; fleet: { id: string; name: string }[] }
export interface BranchCommand { commandId: string; action: BranchAction; requestId?: string; expectedRevision?: number; payload: Record<string, unknown> }
export interface BranchReceipt { commandId: string; committedRevision?: number; request?: WorkRequest; group?: { id: string; revision: number; name: string } }
export interface TimingSummary { samples: number; unclaimed?: number; avgSeconds?: number | null; medianSeconds: number | null }
export interface BranchReportRow { groupId: string; groupName: string; branchName: string | null; received: number; uniqueRequests: number; uniqueCases: number; withoutCase: number; waitingNow: number; unassignedNow: number; inProgressNow: number; completed: number; completedUnknownTime: number; reaction: TimingSummary; assignment: TimingSummary }
export interface BranchReport { from: string; to: string; groups: BranchReportRow[]; workload: { memberId: string; name: string; open: number; inProgress: number }[] }
export const workKinds: Record<WorkRequestKind, string> = { delivery: 'Pristavenie', collection: 'Odvoz vozidla', transfer: 'Presun', tow: 'Odťah' };
export const branchViews: BranchView[] = ['open', 'queue', 'active', 'done', 'all'];
export const branchActions: BranchAction[] = ['create', 'route', 'claim', 'release', 'cancel', 'materialize', 'operate', 'reopen', 'group_save', 'group_member'];
/** Human duration for report timings; unknown stays visible as unknown, never as zero. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 'neznáme';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const hours = Math.floor(seconds / 3600); const minutes = Math.round((seconds % 3600) / 60);
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}
/** Display state of a request: the materialized execution wins once it exists. */
export function workState(request: Pick<WorkRequest, 'status' | 'execution'>): 'queued' | 'claimed' | 'assigned' | 'in_progress' | 'done' | 'cancelled' {
  if (request.status === 'cancelled' || request.execution?.cancelled) return 'cancelled';
  if (request.execution?.done) return 'done';
  if (request.execution?.startedAt) return 'in_progress';
  return request.status === 'assigned' ? 'assigned' : request.status;
}
