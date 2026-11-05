import type { Operation } from "@/domain/operations";
import type { TowingOrder, TowingReference } from "@/domain/towing/types";
import type { WorkRequest, WorkRequestKind } from "@/domain/work-groups";

export type CaseWorkOverviewItem = {
  key: string;
  kind: WorkRequestKind;
  source: "order" | "operation" | "request";
  title: string;
  status: string;
  recipient: string | null;
  assigned: boolean;
  branch: string | null;
  vehicle: string | null;
  from: string;
  to: string;
  time: string | null;
  timeLabel: "Skutočný začiatok" | "Dohodnutý termín";
  href?: string;
};
type Sources = {
  operations?: Operation[];
  orders?: TowingOrder[];
  requests?: WorkRequest[];
  drivers?: { id: string; displayName: string }[];
  branches?: TowingReference[];
};
const physicalStatuses = new Set([
  "en_route",
  "arrived",
  "collected",
  "in_progress",
  "completed",
  "submitted",
]);
function time(actual?: string | null, scheduled?: string | null) {
  const valid = (value?: string | null) => {
    if (!value || !Number.isFinite(Date.parse(value))) return null;
    const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (day) {
      const [, year, month, date] = day.map(Number);
      if (
        month < 1 ||
        month > 12 ||
        date < 1 ||
        date > new Date(Date.UTC(year, month, 0)).getUTCDate()
      )
        return null;
    }
    return value;
  };
  const started = valid(actual);
  return {
    time: started || valid(scheduled),
    timeLabel: started
      ? ("Skutočný začiatok" as const)
      : ("Dohodnutý termín" as const),
  };
}
export const overviewStatusLabels: Record<string, string> = {
  draft: "Čaká na pridelenie",
  queued: "Čaká na pobočku",
  claimed: "Pobočka prevzala",
  assigned: "Pridelené",
  accepted: "Prijaté",
  en_route: "Na ceste",
  arrived: "Na mieste",
  collected: "Vozidlo prevzaté",
  in_progress: "V realizácii",
  completed: "Dokončené",
  submitted: "Na kontrolu",
  needs_changes: "Na doplnenie",
  cancelled: "Zrušené",
};
export function overviewStatusTone(
  status: string,
): "pending" | "active" | "done" | "cancelled" {
  if (status === "cancelled") return "cancelled";
  if (status === "completed" || status === "submitted") return "done";
  return [
    "assigned",
    "accepted",
    "en_route",
    "arrived",
    "collected",
    "in_progress",
  ].includes(status)
    ? "active"
    : "pending";
}

/** Match execution identities; a case can deliberately contain several jobs of one kind. */
export function caseWorkOverviewItems({
  operations = [],
  orders = [],
  requests = [],
  drivers = [],
  branches = [],
}: Sources): CaseWorkOverviewItem[] {
  const items: CaseWorkOverviewItem[] = [];
  const byTow = new Map<string, CaseWorkOverviewItem>();
  const byOperation = new Map<string, CaseWorkOverviewItem>();
  for (const order of orders) {
    const item: CaseWorkOverviewItem = {
      key: `tow:${order.id}`,
      kind: "tow",
      source: "order",
      title: order.number,
      status: order.workStatus,
      recipient:
        drivers.find((driver) => driver.id === order.driverId)?.displayName ||
        null,
      assigned: Boolean(order.driverId),
      branch:
        branches.find((branch) => branch.id === order.fields.branchId)?.name ||
        null,
      vehicle:
        [order.fields.plate, order.fields.subjectDescription]
          .filter(Boolean)
          .join(" · ") || null,
      from: order.fields.pickup,
      to: order.fields.destination || "",
      ...time(
        order.fields.startSource !== "assignment"
          ? order.fields.startedAt
          : null,
        order.fields.plannedAt,
      ),
      href: `/zakazky?orderId=${encodeURIComponent(order.id)}`,
    };
    items.push(item);
    byTow.set(order.id, item);
  }
  for (const operation of operations) {
    const canonical =
      operation.owner === "towing_order"
        ? byTow.get(operation.ownerId)
        : undefined;
    if (canonical) {
      canonical.recipient ||= operation.assignee;
      byOperation.set(operation.id, canonical);
      continue;
    }
    const item: CaseWorkOverviewItem = {
      key: `operation:${operation.id}`,
      kind: operation.kind,
      source: "operation",
      title: operation.caseNumber || "Samostatná jazda",
      status: operation.status,
      recipient: operation.assignee || null,
      assigned: Boolean(operation.assigneeId || operation.assignee),
      branch: null,
      vehicle: operation.vehicle,
      from: operation.from,
      to: operation.to,
      ...time(
        physicalStatuses.has(operation.status) ? operation.startedAt : null,
        operation.scheduledAt,
      ),
    };
    items.push(item);
    byOperation.set(operation.id, item);
    if (operation.owner === "towing_order") byTow.set(operation.ownerId, item);
  }
  for (const request of requests) {
    const execution = request.execution;
    const canonical = execution
      ? byOperation.get(execution.operationId) ||
        (execution.owner === "towing_order"
          ? byTow.get(execution.ownerId)
          : undefined)
      : undefined;
    if (canonical) {
      canonical.branch =
        request.groupName || request.branchName || canonical.branch;
      canonical.recipient ||= execution?.assignee || null;
      continue;
    }
    const item: CaseWorkOverviewItem = {
      key: `request:${request.id}`,
      kind: request.kind,
      source: "request",
      title: request.caseNumber || "Požiadavka pobočke",
      status:
        request.status === "cancelled"
          ? "cancelled"
          : execution?.status || request.status,
      recipient:
        execution?.assignee ||
        (request.claimedByName ? `Dispečer: ${request.claimedByName}` : null),
      assigned: Boolean(execution?.assigneeId || execution?.assignee),
      branch: request.groupName || request.branchName,
      vehicle: request.vehicle,
      from: request.pickup,
      to: request.destination,
      ...time(
        execution && physicalStatuses.has(execution.status)
          ? execution.startedAt
          : null,
        execution?.scheduledAt || request.dueAt,
      ),
    };
    items.push(item);
    if (execution) {
      byOperation.set(execution.operationId, item);
      if (execution.owner === "towing_order")
        byTow.set(execution.ownerId, item);
    }
  }
  return items;
}
