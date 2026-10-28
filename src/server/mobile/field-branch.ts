import "server-only";
import type { BranchCommand, BranchWorkspace, WorkRequest } from "@/domain/work-groups";
import type { MobileBranchAction, MobileBranchGroup, MobileBranchRequest, MobileBranchView, MobileBranchWorkspace, MobileFieldScope } from "@/lib/mobile-api";
import { isHistoryTimestamp } from "@/lib/telephony/call-history-query";
import { isUuid } from "@/lib/telephony/uuid";
import { MutationError } from "@/server/mutation-error";
import { branchWorkspaceFor, commandBranchFor, parseBranchCommand, type BranchUser } from "@/server/branches/service";
import type { MobileFieldActor } from "./field-auth";

/** Pobočka in the app: a local lead (lead seat in an active group) claims requests of
 * their own groups and assigns executors. The branch RPCs authorize every read and
 * command; this layer also keeps a member who is central besides to their lead groups. */
const VIEWS: readonly MobileBranchView[] = ["open", "queue", "active", "done"];
const ACTIONS: readonly MobileBranchAction[] = ["claim", "release", "materialize", "operate", "reopen"];
const KINDS = ["delivery", "collection", "transfer", "tow"];
const STATUSES = ["queued", "claimed", "assigned", "cancelled"];

function unconfirmed(): never { throw new MutationError("Pobočku sa nepodarilo overiť. Skúste znova.", 503, "branch_unconfirmed"); }
function invalid(message = "Neplatný príkaz pobočky."): never { throw new MutationError(message, 400); }
const noSeat = () => new MutationError("Váš účet nemá miesto miestneho dispečera v pobočke.", 403, "mobile_no_branch_seat");
const user = (actor: MobileFieldActor): BranchUser => ({ p_user_id: actor.userId, p_organization_id: actor.organizationId });
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const optionalText = (value: unknown, max: number): string | null => value === null || value === undefined ? null : text(value, max) ? value : unconfirmed();
const optionalDate = (value: unknown): string | null => value === null || value === undefined ? null : isHistoryTimestamp(value) ? value : unconfirmed();
const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : unconfirmed();

function leadGroups(workspace: BranchWorkspace, actor: MobileFieldActor): Set<string> {
  if (!workspace?.actor || workspace.actor.userId !== actor.userId || !Array.isArray(workspace.actor.leadGroups) || !Array.isArray(workspace.requests) || !Array.isArray(workspace.groups)) unconfirmed();
  const ids = new Set(workspace.actor.leadGroups.map(group => String(group.id).toLowerCase()));
  if (!ids.size) throw noSeat();
  return ids;
}
/** Allowlisted: what a lead needs to dispatch; the holder is "me" or a name, never a user id. */
export function projectBranchRequest(value: WorkRequest, userId: string): MobileBranchRequest {
  const r = value as unknown as Record<string, unknown>;
  if (!r || typeof r.id !== "string" || !isUuid(r.id) || !KINDS.includes(r.kind as string) || !STATUSES.includes(r.status as string)
    || typeof r.revision !== "number" || !Number.isSafeInteger(r.revision) || r.revision < 1 || typeof r.groupId !== "string" || !isUuid(r.groupId)
    || !text(r.groupName, 200) || !text(r.pickup ?? "", 1000) || !text(r.destination ?? "", 1000) || !text(r.note ?? "", 4000) || !isHistoryTimestamp(r.routedAt)) unconfirmed();
  const customer = r.customer && typeof r.customer === "object" ? r.customer as Record<string, unknown> : null;
  const execution = r.execution && typeof r.execution === "object" ? r.execution as Record<string, unknown> : null;
  return {
    id: r.id.toLowerCase(), kind: r.kind as MobileBranchRequest["kind"], status: r.status as MobileBranchRequest["status"], revision: r.revision,
    groupId: r.groupId.toLowerCase(), groupName: r.groupName, caseNumber: optionalText(r.caseNumber, 160),
    customer: customer && text(customer.name, 300) && text(customer.phone, 64) && (customer.name || customer.phone) ? { name: customer.name, phone: customer.phone } : null,
    vehicle: optionalText(r.vehicle, 300), pickup: (r.pickup as string | undefined) ?? "", destination: (r.destination as string | undefined) ?? "",
    dueAt: optionalDate(r.dueAt), note: (r.note as string | undefined) ?? "", routedAt: r.routedAt as string,
    claimedByMe: typeof r.claimedBy === "string" && r.claimedBy.toLowerCase() === userId.toLowerCase(), claimedByName: optionalText(r.claimedByName, 300), claimedAt: optionalDate(r.claimedAt),
    execution: execution ? {
      owner: execution.owner === "towing_order" ? "towing_order" : execution.owner === "logistics" ? "logistics" : unconfirmed(),
      status: text(execution.status, 40) ? execution.status : unconfirmed(), revision: count(execution.revision),
      assigneeId: typeof execution.assigneeId === "string" && isUuid(execution.assigneeId) ? execution.assigneeId.toLowerCase() : null, assignee: optionalText(execution.assignee, 300),
      scheduledAt: optionalDate(execution.scheduledAt), plannedEndAt: optionalDate(execution.plannedEndAt), confirmedAt: optionalDate(execution.confirmedAt),
      startedAt: optionalDate(execution.startedAt), finishedAt: optionalDate(execution.finishedAt), done: execution.done === true, cancelled: execution.cancelled === true,
    } : null,
  };
}
function projectGroup(value: BranchWorkspace["groups"][number], receivesNew: boolean): MobileBranchGroup {
  const g = value as unknown as Record<string, unknown>, counts = (g.counts ?? {}) as Record<string, unknown>;
  if (typeof g.id !== "string" || !isUuid(g.id) || !text(g.name, 200) || !Array.isArray(g.members)) unconfirmed();
  return { id: g.id.toLowerCase(), name: g.name, receivesNew, counts: { queued: count(counts.queued), claimed: count(counts.claimed), active: count(counts.active), overdue: count(counts.overdue) },
    members: (g.members as Record<string, unknown>[]).filter(m => m.active === true && typeof m.id === "string" && isUuid(m.id) && text(m.name, 300))
      .map(m => ({ id: (m.id as string).toLowerCase(), name: m.name as string, role: m.role === "lead" ? "lead" as const : "member" as const, canDeliver: m.canDeliver === true, canDrive: m.canDrive === true })) };
}
export function projectBranchWorkspace(workspace: BranchWorkspace, actor: MobileFieldActor, view: MobileBranchView): Omit<MobileBranchWorkspace, keyof MobileFieldScope> {
  const ids = leadGroups(workspace, actor);
  const receives = new Map(workspace.actor.leadGroups.map(group => [String(group.id).toLowerCase(), group.receivesNew === true]));
  const requests = workspace.requests.filter(item => ids.has(String(item.groupId).toLowerCase()))
    .flatMap(item => { try { return [projectBranchRequest(item, actor.userId)]; } catch { return []; } });
  return { view, groups: workspace.groups.filter(group => ids.has(String(group.id).toLowerCase())).map(group => projectGroup(group, receives.get(String(group.id).toLowerCase()) ?? false)),
    requests, totalCount: workspace.actor.central ? requests.length : count(workspace.totalCount), canOperateTowing: workspace.actor.canOperateTowing === true };
}
export async function loadFieldBranch(actor: MobileFieldActor, url: URL): Promise<Omit<MobileBranchWorkspace, keyof MobileFieldScope>> {
  const view = (url.searchParams.get("view") ?? "open") as MobileBranchView;
  if (!VIEWS.includes(view)) invalid("Neplatné zobrazenie pobočky.");
  const groupId = url.searchParams.get("groupId");
  if (groupId !== null && !isUuid(groupId)) invalid("Neplatná pobočka.");
  const first = await branchWorkspaceFor(user(actor), { view, limit: 100, ...(groupId ? { groupId: groupId.toLowerCase() } : {}) });
  const ids = leadGroups(first, actor);
  if (groupId && !ids.has(groupId.toLowerCase())) throw new MutationError("Táto pobočka nie je vaša.", 403, "mobile_no_branch_seat");
  // Central sees the whole organization; one page of it could crowd out the lead's own
  // groups, so a member who is both reads each own group by itself.
  if (!first.actor.central || groupId) return projectBranchWorkspace(first, actor, view);
  const pages = await Promise.all([...ids].map(id => branchWorkspaceFor(user(actor), { view, limit: 100, groupId: id })));
  const merged = { ...first, requests: pages.flatMap(page => page.requests), totalCount: pages.reduce((sum, page) => sum + count(page.totalCount), 0) };
  return { ...projectBranchWorkspace(merged, actor, view), totalCount: merged.totalCount };
}

const uuidOf = (value: unknown, message?: string) => typeof value === "string" && isUuid(value) ? value.toLowerCase() : invalid(message);
const reason = (value: unknown) => typeof value === "string" && value.trim() && value.length <= 1000 ? value.trim() : invalid("Napíšte dôvod (najviac 1000 znakov).");
function readOperate(value: unknown): Record<string, unknown> {
  const command = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
  if (Object.keys(command).some(key => !["action", "expectedRevision", "payload"].includes(key)) || typeof command.expectedRevision !== "number"
    || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) invalid();
  const payload = command.payload && typeof command.payload === "object" && !Array.isArray(command.payload) ? command.payload as Record<string, unknown> : invalid();
  const keys = Object.keys(payload);
  switch (command.action) {
    case "assign": if (keys.some(key => key !== "assigneeId")) invalid(); return { action: "assign", expectedRevision: command.expectedRevision, payload: { assigneeId: uuidOf(payload.assigneeId, "Vyberte vykonávateľa.") } };
    case "confirm": if (keys.length) invalid(); return { action: "confirm", expectedRevision: command.expectedRevision, payload: {} };
    case "cancel": if (keys.some(key => key !== "reason")) invalid(); return { action: "cancel", expectedRevision: command.expectedRevision, payload: { reason: reason(payload.reason) } };
    case "reschedule": {
      if (keys.some(key => !["scheduledAt", "plannedEndAt"].includes(key))) invalid();
      const at = (v: unknown) => v === null || v === undefined ? null : isHistoryTimestamp(v) ? new Date(v).toISOString() : invalid("Termín nie je platný.");
      const scheduledAt = at(payload.scheduledAt), plannedEndAt = at(payload.plannedEndAt);
      if (plannedEndAt && (!scheduledAt || Date.parse(plannedEndAt) <= Date.parse(scheduledAt))) invalid("Predpokladaný koniec musí byť po začiatku.");
      return { action: "reschedule", expectedRevision: command.expectedRevision, payload: { scheduledAt, plannedEndAt } };
    }
    default: return invalid();
  }
}
/** Only the lead's own actions: claim, release, assign (materialize/operate) and reopen. */
export function readBranchCommand(value: unknown): BranchCommand {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
  if (Object.keys(body).some(key => !["commandId", "action", "requestId", "expectedRevision", "payload"].includes(key)) || !ACTIONS.includes(body.action as MobileBranchAction)
    || typeof body.expectedRevision !== "number" || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) invalid();
  const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload as Record<string, unknown> : invalid();
  const keys = Object.keys(payload);
  let checked: Record<string, unknown> = {};
  if (body.action === "release") { if (keys.some(key => key !== "reason")) invalid(); if (payload.reason !== undefined) checked = { reason: reason(payload.reason) }; }
  else if (body.action === "materialize") { if (keys.some(key => key !== "assigneeId")) invalid(); if (payload.assigneeId !== undefined) checked = { assigneeId: uuidOf(payload.assigneeId, "Vyberte vykonávateľa.") }; }
  else if (body.action === "operate") { if (keys.some(key => key !== "command")) invalid(); checked = { command: readOperate(payload.command) }; }
  else if (keys.length) invalid();
  const parsed = parseBranchCommand({ commandId: body.commandId, action: body.action, requestId: uuidOf(body.requestId), expectedRevision: body.expectedRevision, payload: checked });
  return { ...parsed, commandId: parsed.commandId.toLowerCase() };
}
export async function commandFieldBranch(actor: MobileFieldActor, value: unknown): Promise<{ commandId: string; committedRevision: number; request: MobileBranchRequest }> {
  const command = readBranchCommand(value);
  // The request must belong to one of the lead's own groups, also for a member who is central.
  const current = await branchWorkspaceFor(user(actor), { id: command.requestId, view: "all", limit: 1 });
  const ids = leadGroups(current, actor);
  const target = current.requests.find(item => String(item.id).toLowerCase() === command.requestId);
  if (!target || !ids.has(String(target.groupId).toLowerCase())) throw new MutationError("Požiadavka už nie je vo vašej pobočke.", 404);
  const receipt = await commandBranchFor(user(actor), command);
  if (!receipt || String(receipt.commandId).toLowerCase() !== command.commandId || typeof receipt.committedRevision !== "number" || !Number.isSafeInteger(receipt.committedRevision) || !receipt.request) unconfirmed();
  return { commandId: command.commandId, committedRevision: receipt.committedRevision, request: projectBranchRequest(receipt.request, actor.userId) };
}
