import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, fakeError } from "@/test/fake-supabase";
import { MutationError } from "@/server/mutation-error";
import { addMobileCaseNote, parseMobileCaseNote, readMobileCaseNote } from "./case-notes";
import { POST } from "@/app/api/mobile/v1/cases/[id]/notes/route";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), actor: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("./auth", () => ({ requireMobileActor: mocks.actor, mobileEnvironment: () => "test" }));
const id = (n: number) => `71000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = { userId: id(1), profileId: id(2), organizationId: id(3), displayName: "Jana", role: "dispatcher" as const };
const caseId = id(4), mutationId = id(5), input = { mutationId, note: "Zákazník čaká na odťah." };
const request = (body: unknown = input) => new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/cases/" + caseId + "/notes", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
function fixture() {
  const f = createFakeSupabase();
  f.db.seed("motorist_cases", [{ id: caseId, organization_id: actor.organizationId, owner_id: id(90) }]);
  mocks.admin.mockReturnValue(f.admin);
  return f;
}
beforeEach(() => { vi.clearAllMocks(); mocks.actor.mockResolvedValue(actor); });

describe("mobile note input", () => {
  it("trims outer whitespace and preserves a multiline note", () => {
    expect(parseMobileCaseNote({ mutationId, note: "  Prvý riadok\nDruhý riadok  " })).toEqual({ mutationId, note: "Prvý riadok\nDruhý riadok" });
  });
  it.each([null, [], {}, { ...input, mutationId: "invalid" }, { ...input, note: " " }, { ...input, note: 1 },
    { ...input, note: "a\0b" }, { ...input, note: "x".repeat(10001) }, { ...input, actorId: id(90) }, { ...input, caseId }])("rejects invalid or spoofed note %j", value => {
    expect(() => parseMobileCaseNote(value)).toThrow(MutationError);
  });
  it("bounds streamed bytes and requires JSON", async () => {
    await expect(readMobileCaseNote(new Request("https://app.test", { method: "POST", body: "{}" }))).rejects.toMatchObject({ status: 400 });
    await expect(readMobileCaseNote(new Request("https://app.test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }))).rejects.toMatchObject({ status: 400 });
    await expect(readMobileCaseNote(request({ ...input, note: "x".repeat(64001) }))).rejects.toMatchObject({ status: 400 });
  });
});

describe("scoped replay-safe timeline notes", () => {
  it("uses authenticated actor/org rather than case owner and writes no case field", async () => {
    const f = fixture(); const result = await addMobileCaseNote(actor, caseId, input, undefined, f.admin);
    expect(result).toMatchObject({ caseId, mutationId, eventId: mutationId, warnings: [], refreshRequired: true });
    expect(f.db.rows("motorist_case_events")).toEqual([expect.objectContaining({ id: mutationId, organization_id: actor.organizationId, case_id: caseId,
      actor_profile_id: actor.profileId, event_type: "note_added", body: input.note, payload: expect.objectContaining({ source: "mobile_case_note_v1" }) })]);
    expect(f.db.rows("motorist_audit_log")).toEqual([expect.objectContaining({ id: mutationId, actor_profile_id: actor.profileId, entity_id: caseId })]);
    expect(f.db.log.some(entry => entry.table === "motorist_cases" && entry.operation !== "select")).toBe(false);
  });
  it("replays the original receipt after other case edits without adding another event/audit", async () => {
    const f = fixture(); const first = await addMobileCaseNote(actor, caseId, input, undefined, f.admin);
    f.db.update("motorist_cases", { main_note: "Zmena kolegu" }, row => row.id === caseId);
    expect(await addMobileCaseNote(actor, caseId, input, undefined, f.admin)).toEqual(first);
    expect(f.db.rows("motorist_case_events")).toHaveLength(1); expect(f.db.rows("motorist_audit_log")).toHaveLength(1);
  });
  it("handles simultaneous exact retries as one committed note", async () => {
    const f = fixture(); const receipts = await Promise.all([addMobileCaseNote(actor, caseId, input, undefined, f.admin), addMobileCaseNote(actor, caseId, input, undefined, f.admin)]);
    expect(receipts[0]).toEqual(receipts[1]); expect(f.db.rows("motorist_case_events")).toHaveLength(1); expect(f.db.rows("motorist_audit_log")).toHaveLength(1);
  });
  it("rejects a reused identity for changed note without modifying the original", async () => {
    const f = fixture(); await addMobileCaseNote(actor, caseId, input, undefined, f.admin);
    await expect(addMobileCaseNote(actor, caseId, { ...input, note: "Iná poznámka" }, undefined, f.admin)).rejects.toMatchObject({ status: 422, code: "CASE_NOTE_MUTATION_MISMATCH" });
    expect(f.db.rows("motorist_case_events")[0].body).toBe(input.note);
  });
  it.each([{ organization_id: id(91) }, { actor_profile_id: id(92) }, { case_id: id(93) }, { event_type: "case_updated" }, { payload: {} }])("never accepts an unrelated event as a receipt %j", async override => {
    const f = fixture(); await addMobileCaseNote(actor, caseId, input, undefined, f.admin);
    f.db.update("motorist_case_events", override, row => row.id === mutationId);
    await expect(addMobileCaseNote(actor, caseId, input, undefined, f.admin)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(f.db.rows("motorist_case_events")).toHaveLength(1);
  });
  it("rejects a foreign case before any write", async () => {
    const f = fixture(); f.db.update("motorist_cases", { organization_id: id(91) }, row => row.id === caseId);
    await expect(addMobileCaseNote(actor, caseId, input, undefined, f.admin)).rejects.toMatchObject({ status: 404 });
    expect(f.db.rows("motorist_case_events")).toHaveLength(0); expect(f.db.rows("motorist_audit_log")).toHaveLength(0);
  });
  it("does not turn a read error into a new write or empty receipt", async () => {
    const f = fixture(); f.db.failNext("motorist_case_events", "select", "private database failure");
    await expect(addMobileCaseNote(actor, caseId, input, undefined, f.admin)).rejects.toMatchObject({ status: 503 });
    expect(f.db.log.some(entry => entry.operation === "insert")).toBe(false);
  });
  it("keeps confirmed note success when audit fails, then repairs audit with the same identity", async () => {
    const f = fixture(); f.db.failNext("motorist_audit_log", "insert", "private audit failure");
    const first = await addMobileCaseNote(actor, caseId, input, undefined, f.admin);
    expect(first.eventId).toBe(mutationId); expect(first.warnings).toEqual([expect.objectContaining({ code: "case_note_audit_incomplete" })]);
    const replay = await addMobileCaseNote(actor, caseId, input, undefined, f.admin);
    expect(replay.warnings).toEqual([]); expect(f.db.rows("motorist_case_events")).toHaveLength(1); expect(f.db.rows("motorist_audit_log")).toHaveLength(1);
  });
  it("retains the audit warning while repair is unavailable", async () => {
    const f = fixture(); f.db.failNext("motorist_audit_log", "insert", "failure"); await addMobileCaseNote(actor, caseId, input, undefined, f.admin);
    f.db.failNext("motorist_audit_log", "select", "failure");
    expect((await addMobileCaseNote(actor, caseId, input, undefined, f.admin)).warnings).toHaveLength(1);
  });
  it("does not overwrite an unrelated audit with the same ID", async () => {
    const f = fixture(); f.db.seed("motorist_audit_log", [{ id: mutationId, organization_id: id(91), entity_id: caseId }]);
    expect((await addMobileCaseNote(actor, caseId, input, undefined, f.admin)).warnings).toHaveLength(1);
    expect(f.db.rows("motorist_audit_log")).toHaveLength(1);
  });
  it("reports unconfirmed insertion so only the exact command may be retried", async () => {
    const f = fixture(); f.db.failNext("motorist_case_events", "insert", fakeError("secret insertion result", "PGRST000"));
    await expect(addMobileCaseNote(actor, caseId, input, undefined, f.admin)).rejects.toMatchObject({ status: 503, code: "CASE_NOTE_UNCONFIRMED" });
    expect(f.db.rows("motorist_audit_log")).toHaveLength(0);
  });
});

describe("note Bearer route", () => {
  it("authenticates before parsing/writing and keeps errors private", async () => {
    const f = fixture(); mocks.actor.mockRejectedValue(new MutationError("Prihláste sa.", 401));
    const response = await POST(request({ forged: true }), { params: Promise.resolve({ id: caseId }) });
    expect(response.status).toBe(401); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("www-authenticate")).toBe("Bearer"); expect(f.db.log).toHaveLength(0);
  });
  it("returns a minimal versioned scoped receipt and no event payload", async () => {
    fixture(); const response = await POST(request(), { params: Promise.resolve({ id: caseId }) }); const body = await response.json();
    expect(response.status).toBe(201); expect(body).toMatchObject({ ok: true, apiVersion: 1, environment: "test", profileId: actor.profileId, caseId, eventId: mutationId, refreshRequired: true });
    expect(body.payload).toBeUndefined(); expect(body.note).toBeUndefined(); expect(response.headers.get("vary")).toContain("Authorization");
  });
});
