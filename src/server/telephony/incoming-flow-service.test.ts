import { beforeEach, describe, expect, it, vi } from "vitest";
import { type IncomingFlow } from "@/lib/telephony/incoming-flow";
import type { ConfigDeps, RoutingDocument } from "./config-service";
import { incomingFlowsEqual, parseIncomingFlowChanges, saveIncomingFlows, validateIncomingFlowChanges, type IncomingFlowChange } from "./incoming-flow-service";
const mocks = vi.hoisted(() => ({ getDocument: vi.fn(), mapSnapshot: vi.fn() }));
vi.mock("./config-service", async importOriginal => ({ ...(await importOriginal<typeof import("./config-service")>()), getCoherentRoutingDocument: mocks.getDocument, routingDocumentFromSnapshot: mocks.mapSnapshot }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const flow = (): IncomingFlow => ({ version: 1, ending: "hangup", steps: [{ id: id(10), type: "ring", seconds: 20, people: [{ profileId: id(100), application: true, personalNumber: "+421910123456" }] }] });
const change = (): IncomingFlowChange => ({ id: id(1), flow: flow(), expectedFlow: null });
function document(): RoutingDocument {
  return { organizationId: id(999), routingVersion: 7, snapshotId: "a".repeat(32), settingsConfigured: true,
    capabilities: { unifiedIncomingFlow: true, ownedMobileRouting: true, defaultInboundCallMode: "ring_first" },
    groups: [], plans: [], businessHours: [], pauseReasons: [], pauseReasonsInUse: [], ivrMenus: [], settings: null,
    lines: [{ id: id(1), phoneNumber: "+421232408774", label: "TEST", partnerName: null, telnyxNumberId: null, ringPlanId: null, ivrMenuId: null, businessHoursId: null, environment: "development", active: true, incomingFlow: null }],
    operators: [{ profileId: id(100), displayName: "Michal", active: true, role: "admin", accessStatus: "active", settings: null, device: null }],
    limits: { destinationAllowlist: ["SK"], maxRingFanout: 8, maxConcurrentLegs: 9 },
  };
}
const codes = (changes: IncomingFlowChange[], doc: RoutingDocument) => validateIncomingFlowChanges(changes, doc).map(issue => issue.code);
describe("incoming flow configuration validation", () => {
  it("accepts explicit personal number without silently changing operator defaults", () => expect(codes([change()], document())).toEqual([]));
  it("compares stored JSONB independent of property insertion order", () => expect(incomingFlowsEqual({ version: 1, ending: "hangup", steps: [] }, { steps: [], ending: "hangup", version: 1 })).toBe(true));
  it("rejects missing expected flow, duplicate lines and extra fields", () => {
    expect(() => parseIncomingFlowChanges([{ id: id(1), flow: flow() }])).toThrow();
    expect(() => parseIncomingFlowChanges([change(), change()])).toThrow();
    expect(() => parseIncomingFlowChanges([{ ...change(), active: false }])).toThrow();
  });
  it("rejects a missing/inactive/foreign line", () => { const doc = document(); doc.lines = []; expect(codes([change()], doc)).toContain("line_unavailable"); });
  it.each(["inactive", "foreign", "disabled", "role"])("rejects %s operator", mode => {
    const doc = document(); if (mode === "inactive") doc.operators[0].active = false; if (mode === "foreign") doc.operators = []; if (mode === "disabled") doc.operators[0].accessStatus = "disabled"; if (mode === "role") doc.operators[0].role = "driver" as unknown as RoutingDocument["operators"][number]["role"];
    expect(codes([change()], doc)).toContain("operator_unavailable");
  });
  it("refuses unsupported stored flow instead of treating it as absent", () => { const doc = document(); doc.lines[0].incomingFlowInvalid = true; expect(codes([change()], doc)).toContain("flow_unsupported"); });
  it("refuses concurrent flow modification", () => { const doc = document(); doc.lines[0].incomingFlow = flow(); expect(codes([change()], doc)).toContain("flow_conflict"); });
  it.each(["ivr", "return", "target"])("protects %s legacy route", mode => {
    const doc = document(); if (mode === "ivr") doc.lines[0].ivrMenuId = id(90); if (mode === "return") doc.lines[0].returnLineId = id(90); if (mode === "target") doc.lines.push({ ...doc.lines[0], id: id(90), returnLineId: id(1) }); expect(codes([change()], doc)).toContain("legacy_route_unsupported");
  });
  it("permits explicit replacement of queue-first only after Save", () => { const doc = document(); doc.lines[0].inboundCallMode = "queue_first"; expect(codes([change()], doc)).toEqual([]); });
  it("enforces allowlist and rejects routing back into own DID", () => {
    const doc = document(); doc.limits!.destinationAllowlist = ["CZ"]; expect(codes([change()], doc)).toContain("number_not_allowed");
    const payload = change(); payload.flow.steps = [{ id: id(20), type: "external", seconds: 20, number: doc.lines[0].phoneNumber }]; expect(codes([payload], document())).toContain("number_loop");
  });
  it("counts web, mobile app and personal call against real physical cap", () => { const doc = document(); doc.limits!.maxConcurrentLegs = 3; expect(codes([change()], doc)).toContain("fanout_exceeded"); });
  it("rejects ambiguous personal phone ownership across existing legacy members", () => {
    const doc = document(); doc.groups = [{ id: id(50), name: "Legacy", description: null, active: true, members: [{ id: id(51), memberKind: "external_number", profileId: null, ownerProfileId: id(101), externalNumber: "+421910123456", position: 0, ringSecs: null, lastOfferedAt: null, lastAnsweredAt: null }] }];
    expect(codes([change()], doc)).toContain("number_owner_conflict");
  });
  it("rejects ambiguous ownership between two changed lines", () => {
    const doc = document(); doc.lines.push({ ...doc.lines[0], id: id(2) }); doc.operators.push({ ...doc.operators[0], profileId: id(101) });
    const second = change(); second.id = id(2); if (second.flow.steps[0].type === "ring") second.flow.steps[0].people[0].profileId = id(101);
    expect(codes([change(), second], doc)).toContain("number_owner_conflict");
  });
});
describe("atomic incoming flow service", () => {
  let rpc: ReturnType<typeof vi.fn>, audit: ReturnType<typeof vi.fn>, deps: ConfigDeps;
  const input = () => ({ organizationId: id(999), actor: { profileId: id(100), role: "admin" as const }, changes: [change()], expectedVersion: 7, expectedSnapshotId: "a".repeat(32) });
  beforeEach(() => { vi.clearAllMocks(); rpc = vi.fn(); audit = vi.fn().mockResolvedValue({ error: null }); deps = { admin: { rpc, from: () => ({ insert: audit }) } as unknown as ConfigDeps["admin"] }; mocks.getDocument.mockResolvedValue(document()); });
  it("never calls mutation when capability or snapshot is stale", async () => {
    const doc = document(); doc.capabilities!.unifiedIncomingFlow = false; mocks.getDocument.mockResolvedValueOnce(doc); await expect(saveIncomingFlows(deps, input())).rejects.toMatchObject({ code: "config_migration_missing" });
    await expect(saveIncomingFlows(deps, { ...input(), expectedSnapshotId: "b".repeat(32) })).rejects.toMatchObject({ code: "stale_document" }); expect(rpc).not.toHaveBeenCalled();
  });
  it("does not bump routing version or audit unchanged flow", async () => {
    const doc = document(); doc.lines[0].incomingFlow = flow(); mocks.getDocument.mockResolvedValueOnce(doc); const payload = input(); payload.changes[0].expectedFlow = flow();
    const result = await saveIncomingFlows(deps, payload); expect(result.document).toBe(doc); expect(rpc).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
  });
  it("passes exact changed-line CAS and uses committed readback", async () => {
    rpc.mockResolvedValue({ data: { before: {}, after: { committed: true } }, error: null }); const after = document(); after.lines[0].incomingFlow = flow(); after.routingVersion = 8; mocks.mapSnapshot.mockReturnValue(after);
    const result = await saveIncomingFlows(deps, input()); expect(result.document.routingVersion).toBe(8); expect(rpc).toHaveBeenCalledWith("motorist_save_incoming_flow", { p_organization_id: id(999), p_expected_version: 7, p_expected_snapshot_id: "a".repeat(32), p_changes: [{ id: id(1), flow: flow(), expected_flow: null }] }); expect(audit).toHaveBeenCalledOnce();
  });
  it("maps DB concurrency failure and never audits a rejected save", async () => { rpc.mockResolvedValue({ error: { code: "P0001", message: "flow_conflict" } }); await expect(saveIncomingFlows(deps, input())).rejects.toMatchObject({ status: 409 }); expect(audit).not.toHaveBeenCalled(); });
  it("does not call a lost or mismatched readback success", async () => { rpc.mockResolvedValue({ error: null, data: { after: {} } }); mocks.mapSnapshot.mockReturnValue(document()); await expect(saveIncomingFlows(deps, input())).rejects.toMatchObject({ code: "config_save_uncertain" }); expect(audit).not.toHaveBeenCalled(); });
  it("gates direct service writes by role", async () => { await expect(saveIncomingFlows(deps, { ...input(), actor: { profileId: id(100), role: "dispatcher" } })).rejects.toMatchObject({ status: 403 }); expect(mocks.getDocument).not.toHaveBeenCalled(); });
});
