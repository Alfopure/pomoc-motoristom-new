import type { WorkRequestKind } from "./work-groups";

/** One command is one independently retryable work intent, never a legacy handoff slot. */
export interface CaseWorkItem {
  commandId: string;
  kind: WorkRequestKind;
  target: { type: "branch" | "person"; id: string };
  pickup: string;
  destination: string;
  instructions: string;
  scheduledAt: string | null;
  plannedEndAt: string | null;
  fleetAssetId: string | null;
  cycleId: string | null;
  branchId: string | null;
}
export interface CaseWorkContext {
  actorKey: string;
  canOperateTowing: boolean;
  pickup: string;
  destination: string;
  groups: { id: string; name: string; kinds: WorkRequestKind[] }[];
  people: { id: string; name: string; kinds: WorkRequestKind[] }[];
  branches: { id: string; name: string }[];
  fleet: { id: string; name: string }[];
  cycles: { id: string; vehicle: string; caseId: string | null }[];
  existing?: {
    id: string;
    kind: WorkRequestKind;
    recipient: string;
    status: string;
  }[];
  existingMore?: boolean;
}
export interface CaseWorkReceipt {
  commandId: string;
  kind: WorkRequestKind;
  owner: "branch" | "logistics" | "towing_order";
  id: string;
  status: string;
}
export type CaseWorkResult =
  | { commandId: string; receipt: CaseWorkReceipt }
  | { commandId: string; error: string; status: number };
export function isCaseWorkReceipt(
  value: unknown,
  item: CaseWorkItem,
): value is CaseWorkReceipt {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<CaseWorkReceipt>;
  return (
    r.commandId === item.commandId &&
    r.kind === item.kind &&
    r.owner ===
      (item.target.type === "branch"
        ? "branch"
        : item.kind === "tow"
          ? "towing_order"
          : "logistics") &&
    typeof r.id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      r.id,
    ) &&
    r.status === (item.target.type === "branch" ? "queued" : "assigned")
  );
}
