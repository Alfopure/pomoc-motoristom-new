import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CaseWorkContext,
  CaseWorkItem,
  CaseWorkReceipt,
  CaseWorkResult,
} from "@/domain/case-work";
import { isCaseWorkReceipt } from "@/domain/case-work";
import { workKinds } from "@/domain/work-groups";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { handoffSession, getCaseHandoffContext } from "./case-handoff";
import { branchWorkspaceFor } from "./branches/service";
import { operationsWorkspaceFor } from "./operations";
import { queueWorkPush } from "./mobile/push-outbox";
import { TowingError, mapRpcError, uuid } from "./towing/http";

function caseWorkEnvelope(input: Record<string, unknown>) {
  if (
    Object.keys(input).some((key) => key !== "items") ||
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > 12
  )
    throw new TowingError(
      "invalid_input",
      400,
      "Vyberte jednu až dvanásť prác.",
    );
  const ids = new Set<string>();
  return input.items.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new TowingError("invalid_input", 400, "Neplatné zadanie práce.");
    const item = value as Record<string, unknown>;
    const commandId = uuid(item.commandId);
    if (ids.has(commandId))
      throw new TowingError(
        "invalid_input",
        400,
        "Každá práca potrebuje vlastný identifikátor.",
      );
    ids.add(commandId);
    return { value: item, commandId };
  });
}
export function parseCaseWork(input: Record<string, unknown>): CaseWorkItem[] {
  return caseWorkEnvelope(input).map(({ value: v, commandId }) => {
    const allowed = [
      "commandId",
      "kind",
      "target",
      "pickup",
      "destination",
      "instructions",
      "scheduledAt",
      "plannedEndAt",
      "fleetAssetId",
      "cycleId",
      "branchId",
    ];
    if (
      Object.keys(v).some((k) => !allowed.includes(k)) ||
      typeof v.kind !== "string" ||
      !Object.hasOwn(workKinds, v.kind)
    )
      throw new TowingError("invalid_input", 400, "Vyberte druh práce.");
    const target = v.target as Record<string, unknown> | null;
    if (
      !target ||
      typeof target !== "object" ||
      Array.isArray(target) ||
      Object.keys(target).some((k) => !["type", "id"].includes(k)) ||
      !["branch", "person"].includes(String(target.type))
    )
      throw new TowingError(
        "invalid_input",
        400,
        "Vyberte pobočku alebo človeka.",
      );
    const text = (key: string, max: number) => {
      const s = v[key];
      if (typeof s !== "string" || s.length > max)
        throw new TowingError(
          "invalid_input",
          400,
          "Skontrolujte miesta a pokyny.",
        );
      return s.trim();
    };
    const date = (key: string) => {
      if (v[key] === null || v[key] === "") return null;
      if (
        typeof v[key] !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(
          v[key] as string,
        ) ||
        !Number.isFinite(Date.parse(v[key] as string)) ||
        new Date(v[key] as string).toISOString().slice(0, 10) !==
          (v[key] as string).slice(0, 10)
      )
        throw new TowingError("invalid_input", 400, "Zadajte platný termín.");
      return new Date(v[key] as string).toISOString();
    };
    const scheduledAt = date("scheduledAt"),
      plannedEndAt = date("plannedEndAt");
    if (plannedEndAt && (!scheduledAt || plannedEndAt <= scheduledAt))
      throw new TowingError(
        "invalid_input",
        400,
        "Koniec musí nasledovať po začiatku.",
      );
    const nullableId = (key: string) =>
      v[key] === null || v[key] === "" ? null : uuid(v[key]);
    const cycleId = nullableId("cycleId");
    if (v.kind === "collection" && !cycleId)
      throw new TowingError(
        "invalid_input",
        400,
        "Pri odvoze vyberte používanie vozidla.",
      );
    const pickup = text("pickup", 1000);
    if (!pickup)
      throw new TowingError(
        "invalid_input",
        400,
        "Doplňte miesto začiatku práce.",
      );
    return {
      commandId,
      kind: v.kind as CaseWorkItem["kind"],
      target: { type: target.type as "branch" | "person", id: uuid(target.id) },
      pickup,
      destination: text("destination", 1000),
      instructions: text("instructions", 4000),
      scheduledAt,
      plannedEndAt,
      fleetAssetId: nullableId("fleetAssetId"),
      cycleId,
      branchId: nullableId("branchId"),
    };
  });
}
export async function getCaseWorkContext(
  caseId: string,
): Promise<CaseWorkContext> {
  const session = await handoffSession();
  uuid(caseId);
  const { actor } = session;
  const [preview, branches, operations] = await Promise.all([
    getCaseHandoffContext(caseId, session),
    branchWorkspaceFor(
      { p_user_id: actor.userId, p_organization_id: actor.organizationId },
      { caseId, view: "all", limit: 50 },
    ),
    operationsWorkspaceFor(actor, { caseId, view: "all", limit: 50 }),
  ]);
  return {
    actorKey: `${actor.organizationId}:${actor.userId}`,
    canOperateTowing: branches.actor.canOperateTowing,
    pickup: preview.preview.pickup?.address ?? "",
    destination: preview.preview.destination?.address ?? "",
    groups: branches.groups
      .filter((g) => g.active)
      .map((g) => ({ id: g.id, name: g.name, kinds: g.serviceKinds })),
    people: branches.people.flatMap((p) => {
      const kinds: CaseWorkItem["kind"][] = [];
      if (operations.members.some((m) => m.id === p.id))
        kinds.push("delivery", "collection", "transfer");
      if (branches.actor.canOperateTowing && p.roles.includes("driver"))
        kinds.push("tow");
      return kinds.length ? [{ id: p.id, name: p.name, kinds }] : [];
    }),
    branches: branches.branches,
    fleet: operations.fleet,
    cycles: branches.cycles,
    existing: [
      ...branches.requests.map((r) => ({
        id: r.id,
        kind: r.kind,
        recipient: r.groupName,
        status: r.execution?.status ?? r.status,
      })),
      ...operations.operations
        .filter(
          (o) =>
            !branches.requests.some((r) => r.execution?.operationId === o.id),
        )
        .map((o) => ({
          id: o.id,
          kind: o.kind,
          recipient: o.assignee ?? "Nepridelené",
          status: o.status,
        })),
    ],
    existingMore:
      branches.totalCount > branches.requests.length ||
      operations.totalCount > operations.operations.length,
  };
}
export async function commandCaseWork(
  caseId: string,
  input: Record<string, unknown>,
): Promise<{ results: CaseWorkResult[] }> {
  const { actor } = await handoffSession();
  uuid(caseId);
  const items = caseWorkEnvelope(input);
  const admin = createSupabaseAdminClient() as unknown as SupabaseClient;
  const results: CaseWorkResult[] = [];
  for (const { value, commandId } of items) {
    try {
      const item = parseCaseWork({ items: [value] })[0];
      const result = await admin.rpc("motorist_case_work_item", {
        p_user_id: actor.userId,
        p_organization_id: actor.organizationId,
        p_case_id: caseId,
        p_item: item,
      });
      mapRpcError(result.error);
      if (!isCaseWorkReceipt(result.data, item))
        throw new TowingError(
          "unconfirmed",
          503,
          "Výsledok nie je potvrdený. Overte tú istú prácu.",
        );
      results.push({
        commandId: item.commandId,
        receipt: result.data as CaseWorkReceipt,
      });
    } catch (e) {
      results.push({
        commandId,
        error:
          e instanceof TowingError
            ? e.message
            : "Výsledok nie je potvrdený. Overte tú istú prácu.",
        status: e instanceof TowingError ? e.status : 503,
      });
    }
  }
  if (results.some((r) => "receipt" in r)) queueWorkPush(actor.organizationId);
  return { results };
}
