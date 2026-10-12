import { beforeEach, describe, expect, it, vi } from "vitest";
import { multiLineRoutingFixture, ids, extraIds } from "../../../e2e/fixtures/incoming-routing-data";
import type { ConfigDeps } from "./config-service";
import { parseLineWorkspaceChanges, saveLineWorkspace, type LineWorkspaceChange } from "./line-workspace-service";
const mocks = vi.hoisted(() => ({ getDocument: vi.fn(), mapSnapshot: vi.fn() }));
vi.mock("./config-service", async original => ({ ...(await original<typeof import("./config-service")>()), getCoherentRoutingDocument: mocks.getDocument, routingDocumentFromSnapshot: mocks.mapSnapshot }));
const rpc = vi.fn(), audit = vi.fn();
const deps = { admin: { rpc, from: () => ({ insert: audit }) } } as unknown as ConfigDeps;
const document = () => { const doc = structuredClone(multiLineRoutingFixture); doc.capabilities = { ...doc.capabilities!, unifiedIncomingFlow: true, lineWorkspace: true }; doc.snapshotId = "a".repeat(32); return doc; };
const change = (): LineWorkspaceChange => ({ id: ids.line, flow: { version: 1, ending: "hangup", steps: [{ id: "00000000-0000-4000-8000-000000000999", type: "line", lineId: extraIds.secondLine }] }, expectedFlow: null, patch: { label: "Odťahovka" } });
const input = () => ({ organizationId: ids.organization, actor: { profileId: ids.jana, role: "admin" as const }, changes: [change()], expectedVersion: 5, expectedSnapshotId: "a".repeat(32) });
beforeEach(() => { vi.resetAllMocks(); mocks.getDocument.mockResolvedValue(document()); audit.mockResolvedValue({ error: null }); });
describe("atomic line workspace API", () => {
  it("requires manager permission, capability and current snapshot before writing", async () => {
    await expect(saveLineWorkspace(deps, { ...input(), actor: { profileId: ids.jana, role: "dispatcher" } })).rejects.toMatchObject({ status: 403 });
    const unavailable = document(); unavailable.capabilities!.lineWorkspace = false; mocks.getDocument.mockResolvedValueOnce(unavailable);
    await expect(saveLineWorkspace(deps, input())).rejects.toMatchObject({ code: "config_migration_missing" });
    await expect(saveLineWorkspace(deps, { ...input(), expectedVersion: 4 })).rejects.toMatchObject({ status: 409 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("rejects circular candidate routing before the transaction", async () => {
    const doc = document(); doc.lines[2].incomingFlow = { ...change().flow!, steps: [{ id: "00000000-0000-4000-8000-000000000998", type: "line", lineId: ids.line }] };
    mocks.getDocument.mockResolvedValueOnce(doc);
    await expect(saveLineWorkspace(deps, input())).rejects.toMatchObject({ code: "config_invalid", issues: expect.arrayContaining([expect.objectContaining({ code: "line_loop" })]) });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("writes properties and flow together and verifies the committed response", async () => {
    const after = document(); Object.assign(after.lines[1], { label: "Odťahovka", incomingFlow: change().flow }); after.routingVersion++;
    rpc.mockResolvedValue({ data: { after: {} }, error: null }); mocks.mapSnapshot.mockReturnValue(after);
    expect((await saveLineWorkspace(deps, input())).document.routingVersion).toBe(6);
    expect(rpc).toHaveBeenCalledWith("motorist_save_line_workspace", expect.objectContaining({ p_changes: [{ id: ids.line, flow: change().flow, expected_flow: null, patch: { label: "Odťahovka" } }] }));
    expect(audit).toHaveBeenCalledOnce();
  });
  it("never reports a partially matching response as saved", async () => {
    const after = document(); after.lines[1].incomingFlow = change().flow;
    rpc.mockResolvedValue({ data: { after: {} }, error: null }); mocks.mapSnapshot.mockReturnValue(after);
    await expect(saveLineWorkspace(deps, input())).rejects.toMatchObject({ code: "config_save_uncertain" });
    expect(audit).not.toHaveBeenCalled();
  });
  it("rejects unknown properties, malformed patches and missing expected flow", () => {
    expect(() => parseLineWorkspaceChanges([{ ...change(), patch: { providerKey: "x" } }])).toThrow();
    expect(() => parseLineWorkspaceChanges([{ ...change(), patch: null }])).toThrow();
    expect(() => parseLineWorkspaceChanges([{ id: ids.line, flow: change().flow }])).toThrow();
  });
});
