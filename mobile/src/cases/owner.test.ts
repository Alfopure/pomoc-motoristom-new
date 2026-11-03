import { describe, expect, it, vi } from "vitest";
import type { MobileCaseOwnerAssigned, MobileCaseOwnerContext, MobileCaseOwnerInput } from "../../../src/lib/mobile-api";
import { CaseOwnerDraft } from "./owner";
import { deferred, memoryPort } from "../work/draft-test-port";
import { DraftNotSentError } from "../drafts/port";
import { MobileApiError } from "../lib/api";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const caseId = id(2), actor = id(1), target = id(3), mutation = id(4), revision = "2026-10-12T12:00:00.000001Z";
const scope = { ok: true as const, apiVersion: 1 as const, environment: "test" as const, profileId: actor, checkedAt: revision };
const context: MobileCaseOwnerContext = { ...scope, caseId, caseRevision: revision, owner: { id: null, name: null, mine: false }, available: true, capabilities: { take: true, assign: true }, targets: [{ id: actor, name: "Ja" }, { id: target, name: "Kolega" }] };
const receipt: MobileCaseOwnerAssigned = { ...scope, caseId, mutationId: mutation, ownerId: target, committedRevision: "2026-10-12T12:00:00.000002Z", refreshRequired: true };
function fixture(saved?: unknown) {
  const memory = memoryPort(saved), api = { ownerContext: vi.fn(async () => context), assignOwner: vi.fn(async (_id: string, _input: MobileCaseOwnerInput) => receipt) };
  const uuid = vi.fn(() => mutation), draft = new CaseOwnerDraft(api, caseId, uuid, memory.port);
  return { ...memory, api, uuid, draft };
}
describe("case owner exact durable command", () => {
  it("awaits WAL, guards double tap, then keeps known receipt when local finish fails", async () => {
    const f = fixture(), hold = deferred<void>(); await f.draft.refresh(); f.draft.select(target);
    const original = f.port.prepare; f.port.prepare = vi.fn(async value => { await hold.promise; return original(value); });
    const saving = f.draft.submit(); await f.draft.submit(); expect(f.api.assignOwner).not.toHaveBeenCalled(); f.record.finishOk = false; hold.resolve(); await saving;
    expect(f.api.assignOwner).toHaveBeenCalledOnce(); expect(f.draft.snapshot().status).toBe("saved"); f.draft.reset(); expect(f.draft.snapshot().status).toBe("saved");
  });
  it("local preparation failure never reaches transport or creates unknown state", async () => {
    const f = fixture(); await f.draft.refresh(); f.draft.select(target); f.port.prepare = vi.fn().mockRejectedValue(new DraftNotSentError());
    await f.draft.submit(); expect(f.api.assignOwner).not.toHaveBeenCalled(); expect(f.draft.snapshot().status).toBe("editing");
  });
  it("unknown restart replays exact revision/UUID after later typed409 without new identity", async () => {
    const f = fixture(); await f.draft.refresh(); f.draft.select(target); f.api.assignOwner.mockRejectedValueOnce(new MobileApiError("unknown", 0)); await f.draft.submit(); f.draft.dispose();
    const next = fixture(f.record.payload); next.api.assignOwner.mockRejectedValueOnce(new MobileApiError("conflict", 409, "CASE_REVISION_CONFLICT"));
    expect(next.draft.snapshot().status).toBe("uncertain"); expect(next.api.assignOwner).not.toHaveBeenCalled(); next.draft.select(actor); await next.draft.reconcile(); expect(next.draft.snapshot().status).toBe("uncertain");
    await next.draft.reconcile(); expect(next.api.assignOwner.mock.calls.map(c => c[1])).toEqual([f.api.assignOwner.mock.calls[0][1], f.api.assignOwner.mock.calls[0][1]]); expect(next.uuid).not.toHaveBeenCalled();
  });
  it("initial revision conflict requires fresh context and conscious review", async () => {
    const f = fixture(); await f.draft.refresh(); f.draft.select(target); f.api.assignOwner.mockRejectedValueOnce(new MobileApiError("conflict", 409, "CASE_REVISION_CONFLICT")); await f.draft.submit();
    expect(f.draft.snapshot().status).toBe("conflict"); f.draft.review(); expect(f.draft.snapshot().status).toBe("conflict");
    f.api.ownerContext.mockResolvedValue({ ...context, caseRevision: receipt.committedRevision }); await f.draft.refresh(); f.draft.review();
    expect(f.draft.snapshot()).toMatchObject({ status: "editing", selectedId: target });
  });
  it("fresh capability loss does not unlock unknown command", async () => {
    const f = fixture(); await f.draft.refresh(); f.draft.select(target); f.api.assignOwner.mockRejectedValue(new MobileApiError("unknown", 503)); await f.draft.submit();
    f.api.ownerContext.mockResolvedValue({ ...context, available: false, capabilities: { take: false, assign: false }, targets: [] }); await f.draft.refresh(); f.draft.review(); f.draft.reset();
    expect(f.draft.snapshot().status).toBe("uncertain");
  });
  it("hidden controller cannot initiate reconciliation but retains original pending", async () => {
    const f = fixture(); await f.draft.refresh(); f.draft.select(target); f.api.assignOwner.mockRejectedValueOnce(new MobileApiError("unknown", 503)); await f.draft.submit();
    f.draft.setActive(false); await f.draft.reconcile(); expect(f.api.assignOwner).toHaveBeenCalledOnce(); expect(f.draft.snapshot().status).toBe("uncertain");
    f.draft.setActive(true); await f.draft.reconcile(); expect(f.api.assignOwner).toHaveBeenCalledTimes(2);
  });
  it("records late confirmed receipt before disposed UI fence", async () => {
    const f = fixture(), network = deferred<MobileCaseOwnerAssigned>(); await f.draft.refresh(); f.draft.select(target); f.api.assignOwner.mockReturnValue(network.promise);
    const saving = f.draft.submit(); await vi.waitFor(() => expect(f.api.assignOwner).toHaveBeenCalledOnce()); f.draft.dispose(); network.resolve(receipt); await saving;
    expect(fixture(f.record.payload).draft.snapshot().status).toBe("saved");
  });
  it("does not accept a foreign/mismatched stored receipt or malformed pending", () => {
    for (const pending of [null, { mutationId: mutation, expectedUpdatedAt: revision, ownerId: target, extra: true }]) {
      const f = fixture({ version: 1, caseId, canRecover: false, status: "uncertain", selectedId: target, baseline: { revision, owner: context.owner }, pending, receipt: null });
      expect(f.record.reject).toBe(true);
    }
  });
  it.each([[409, "environment_mismatch"], [422, "CASE_MUTATION_MISMATCH"]])("initial fail-closed denial %i cannot reset through fresh context", async (status, code) => {
    const f = fixture(); await f.draft.refresh(); f.draft.select(target); f.api.assignOwner.mockRejectedValue(new MobileApiError("Denied", status as number, code as string)); await f.draft.submit();
    await f.draft.refresh(); f.draft.review(); f.draft.reset(); await f.draft.submit(); expect(f.draft.snapshot().status).toBe("blocked"); expect(f.api.assignOwner).toHaveBeenCalledOnce();
  });
  it("does not apply hidden or late context reads", async () => {
    const f = fixture(), read = deferred<MobileCaseOwnerContext>(); f.api.ownerContext.mockReturnValue(read.promise); const refreshing = f.draft.refresh(); f.draft.setActive(false); read.resolve(context); await refreshing;
    expect(f.draft.snapshot().context).toBeNull();
  });
});
