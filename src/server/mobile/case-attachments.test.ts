import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createFakeSupabase, fakeError, type FakeRow } from "@/test/fake-supabase";
import { MOBILE_CASE_ATTACHMENT_MAX_BYTES } from "@/lib/mobile-api";
import { MutationError } from "@/server/mutation-error";
import { addMobileCaseAttachment, listMobileCaseAttachments, downloadMobileCaseAttachment, readMobileCaseAttachment } from "./case-attachments";
import { GET as DOWNLOAD } from "@/app/api/mobile/v1/cases/[id]/attachments/[attachmentId]/download/route";
import { GET, POST } from "@/app/api/mobile/v1/cases/[id]/attachments/route";
const mocks = vi.hoisted(() => ({ admin: vi.fn(), actor: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("./auth", () => ({ requireMobileActor: mocks.actor, mobileEnvironment: () => "test" }));
vi.mock("@/lib/supabase/env", () => ({ getSupabasePublicEnv: () => ({ url: "https://test-project.supabase.co", publicKey: "public" }) }));
const id = (n: number) => `81000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = { userId: id(1), profileId: id(2), organizationId: id(3), displayName: "Jana", role: "dispatcher" as const };
const caseId = id(4), mutationId = id(5), revision = "2026-10-11T10:00:00.123456+00:00", committed = "2026-10-11T10:01:00.654321+00:00";
const command = { mutationId, expectedUpdatedAt: revision, fileName: "Žlté vozidlo.jpg", category: "photo" as const, note: "Pohľad spredu" };
const bytes = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 255, 217]);
const upload = { command, bytes, mimeType: "image/jpeg" };
const bucket = "motorist-case-attachments";
const path = `${actor.organizationId}/cases/${caseId}/mobile/${actor.profileId}/${mutationId}`;
function request(input: unknown = command, file = new File([bytes], "attachment.bin", { type: "image/jpeg" })) {
  const form = new FormData(); form.append("command", JSON.stringify(input)); form.append("file", file);
  return new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/cases/" + caseId + "/attachments", { method: "POST", body: form });
}
function fixture(existing: unknown[] = []) {
  const f = createFakeSupabase();
  f.db.seed("motorist_cases", [{ id: caseId, organization_id: actor.organizationId, updated_at: revision, attachments_metadata: existing }]);
  const receipts = new Map<string, { fingerprint: unknown; row: FakeRow }>();
  f.db.registerRpc("motorist_case_mutation_result", args => {
    const saved = receipts.get(String(args.p_mutation_id));
    if (saved && saved.fingerprint !== args.p_fingerprint) throw fakeError("different", "PT422");
    return saved?.row ?? null;
  });
  f.db.registerRpc("motorist_save_case_atomic", args => {
    const saved = receipts.get(String(args.p_mutation_id));
    if (saved) { if (saved.fingerprint !== args.p_fingerprint) throw fakeError("different", "PT422"); return saved.row; }
    const row = f.db.find("motorist_cases", r => r.id === args.p_case_id && r.organization_id === args.p_organization_id);
    if (!row) throw fakeError("missing", "P0002");
    if (row.updated_at !== args.p_expected_updated_at) throw fakeError("conflict", "PT409");
    const next = { ...row, ...args.p_case_patch as FakeRow, updated_at: committed };
    f.db.update("motorist_cases", next, r => r.id === caseId);
    receipts.set(String(args.p_mutation_id), { fingerprint: args.p_fingerprint, row: next }); return next;
  });
  let stored: { bytes: Uint8Array; metadata: Record<string, unknown>; mime: string } | null = null;
  const storage = {
    upload: vi.fn(async (_path: string, body: Uint8Array, options: { metadata: Record<string, unknown>; contentType: string }) => {
      if (stored) return { data: null, error: { statusCode: "409", message: "exists" } };
      stored = { bytes: Uint8Array.from(body), metadata: structuredClone(options.metadata), mime: options.contentType };
      return { data: { path: _path }, error: null };
    }),
    info: vi.fn(async () => ({ data: stored && { name: path, bucketId: bucket, size: stored.bytes.length, contentType: stored.mime, metadata: stored.metadata }, error: null })),
    download: vi.fn(() => ({ asStream: async () => ({ data: stored && new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(stored!.bytes); controller.close(); } }), error: null }) })),
    createSignedUrl: vi.fn(async () => ({ data: { signedUrl: `https://test-project.supabase.co/storage/v1/object/sign/${bucket}/${path}?token=opaque` }, error: null })),
    remove: vi.fn(),
  };
  Object.assign(f.admin, { storage: { from: vi.fn(() => storage) } }); mocks.admin.mockReturnValue(f.admin);
  return { ...f, storage, receipts, get stored() { return stored!; } };
}
beforeEach(() => { vi.clearAllMocks(); mocks.actor.mockResolvedValue(actor); });

describe("bounded mobile attachment command", () => {
  it("preserves UTF-8 filename, exact bytes and microsecond revision", async () => {
    expect(await readMobileCaseAttachment(request())).toEqual(upload);
  });
  it.each([null, [], 1, { ...command, actorId: id(7) }, { ...command, fileName: "x\ud800.jpg" }, { ...command, fileName: "ž".repeat(121) }, { ...command, fileName: " leading.jpg" }, { ...command, expectedUpdatedAt: "bad" }, { ...command, mutationId: "bad" }, { ...command, fileName: "../x.jpg" }, { ...command, note: "x".repeat(2001) }])("rejects unsafe or spoofed command %j", async value => {
    await expect(readMobileCaseAttachment(request(value))).rejects.toMatchObject({ status: 400 });
  });
  it("requires revision before storage and rejects filename/header or MIME/bytes disagreement", async () => {
    await expect(readMobileCaseAttachment(request({ ...command, expectedUpdatedAt: undefined }))).rejects.toMatchObject({ status: 428 });
    await expect(readMobileCaseAttachment(request(command, new File([bytes], "other.jpg", { type: "image/jpeg" })))).rejects.toMatchObject({ status: 400 });
    await expect(readMobileCaseAttachment(request(command, new File(["not jpeg"], "attachment.bin", { type: "image/jpeg" })))).rejects.toMatchObject({ status: 400 });
    await expect(readMobileCaseAttachment(request(command, new File([bytes], "attachment.bin", { type: "application/pdf" })))).rejects.toMatchObject({ status: 400 });
  });
  it.each([["image/png", [137, 80, 78, 71, 13, 10, 26, 10]], ["application/pdf", [37, 80, 68, 70, 45, 49, 46, 55]]] as const)("accepts signature-matched %s", async (mimeType, value) => {
    const file = new File([new Uint8Array(value)], "attachment.bin", { type: mimeType });
    expect((await readMobileCaseAttachment(request(command, file))).mimeType).toBe(mimeType);
  });
  it("rejects empty files, unknown multipart fields and malformed JSON", async () => {
    await expect(readMobileCaseAttachment(request(command, new File([], "attachment.bin", { type: "image/jpeg" })))).rejects.toMatchObject({ status: 400 });
    const form = await request().formData(); form.append("spoof", "value");
    await expect(readMobileCaseAttachment(new Request("https://app.test", { method: "POST", body: form }))).rejects.toMatchObject({ status: 400 });
    form.delete("spoof"); form.set("command", "{");
    await expect(readMobileCaseAttachment(new Request("https://app.test", { method: "POST", body: form }))).rejects.toMatchObject({ status: 400 });
  });
  it("rejects duplicate fields and extra files", async () => {
    const original = request(), form = await original.formData(); form.append("command", JSON.stringify(command));
    await expect(readMobileCaseAttachment(new Request(original.url, { method: "POST", body: form }))).rejects.toMatchObject({ status: 400 });
  });
  it("bounds bytes before multipart parsing without trusting Content-Length", async () => {
    const req = new Request("https://app.test", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x", "Content-Length": "1" }, body: new Uint8Array(MOBILE_CASE_ATTACHMENT_MAX_BYTES + 64_001) });
    await expect(readMobileCaseAttachment(req)).rejects.toMatchObject({ status: 413 });
    await expect(readMobileCaseAttachment(request(command, new File([new Uint8Array(MOBILE_CASE_ATTACHMENT_MAX_BYTES + 1)], "attachment.bin", { type: "image/jpeg" })))).rejects.toMatchObject({ status: 413 });
  });
});

describe("atomic attachment upload and reconciliation", () => {
  it("appends raw metadata unchanged under actor/org and exact revision", async () => {
    const old = { id: id(20), fileName: "legacy.doc", category: "document", privateUnknown: { preserve: true }, storagePath: "legacy" };
    const f = fixture([old]); const result = await addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin);
    expect(result).toMatchObject({ caseId, mutationId, committedRevision: committed, refreshRequired: true, attachment: { id: mutationId, fileName: command.fileName, downloadable: true } });
    const call = f.db.log.find(e => e.table === "motorist_save_case_atomic")!.payload as FakeRow;
    expect(call).toMatchObject({ p_actor_id: actor.profileId, p_organization_id: actor.organizationId, p_expected_updated_at: revision, p_related: [] });
    expect((call.p_case_patch as FakeRow).attachments_metadata).toEqual([old, expect.objectContaining({ id: mutationId, storagePath: path, storageBucket: bucket })]);
    expect(f.storage.upload).toHaveBeenCalledWith(path, bytes, expect.objectContaining({ upsert: false, metadata: expect.objectContaining({ contentSha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length }) }));
    expect(f.storage.remove).not.toHaveBeenCalled();
  });
  it.each(["revision", "same ID"])("recovers exact receipt when another request commits between lookup and %s rejection", async scenario => {
    const f = fixture(), lookup = f.db.rpcHandlers.get("motorist_case_mutation_result")!;
    let first = true;
    f.db.registerRpc("motorist_case_mutation_result", async (args, db) => {
      if (!first) return lookup(args, db);
      first = false;
      await addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin);
      if (scenario === "same ID") f.db.update("motorist_cases", { updated_at: revision }, () => true);
      return null;
    });
    const result = await addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin);
    expect(result.committedRevision).toBe(committed); expect(result.mutationId).toBe(mutationId);
    expect(f.storage.upload).toHaveBeenCalledTimes(1); expect(f.db.rows("motorist_cases")[0].attachments_metadata).toHaveLength(1);
  });
  it("simultaneous exact commands append once and return the same committed receipt", async () => {
    const f = fixture();
    const results = await Promise.all([addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin), addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin)]);
    expect(results[0]).toEqual(results[1]); expect(f.db.rows("motorist_cases")[0].attachments_metadata).toHaveLength(1); expect(f.receipts.size).toBe(1);
  });
  it.each([undefined, "", "  preserve this  "])("preserves optional/empty/whitespace note %j", async note => {
    const f = fixture(); const withoutNote = { mutationId, expectedUpdatedAt: revision, fileName: command.fileName, category: command.category };
    const changed = { ...upload, command: note === undefined ? withoutNote : { ...withoutNote, note } };
    expect((await addMobileCaseAttachment(actor, caseId, changed, undefined, f.admin)).attachment.note).toBe(note ?? null);
  });
  it("stops on uncertain receipt lookup before accessing case or storage", async () => {
    const f = fixture(); f.db.failNext("motorist_case_mutation_result", "rpc", fakeError("unknown", "PGRST000"));
    await expect(addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin)).rejects.toMatchObject({ code: "CASE_ATTACHMENT_UNCONFIRMED" });
    expect(f.db.log).toHaveLength(1); expect(f.storage.upload).not.toHaveBeenCalled();
  });
  it("never appends metadata after a failed storage upload or hides private transport messages", async () => {
    const f = fixture(); f.storage.upload.mockRejectedValueOnce(new Error("secret provider detail"));
    const response = await POST(request(), { params: Promise.resolve({ id: caseId }) });
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("secret provider detail");
    expect(f.db.log.some(e => e.table === "motorist_save_case_atomic")).toBe(false); expect(f.storage.remove).not.toHaveBeenCalled();
  });
  it("replays original receipt before latest case/storage even after later case change", async () => {
    const f = fixture(); const first = await addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin);
    f.db.update("motorist_cases", { updated_at: "2026-10-12T10:00:00Z", attachments_metadata: [] }, () => true);
    f.db.log.length = 0; vi.clearAllMocks();
    expect(await addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin)).toEqual(first);
    expect(f.db.log.map(e => e.table)).toEqual(["motorist_case_mutation_result"]);
    expect(f.storage.upload).not.toHaveBeenCalled(); expect(f.storage.info).not.toHaveBeenCalled();
  });
  it("reconciles storage collision only after whole command metadata and actual bytes agree", async () => {
    const f = fixture(); f.db.failNext("motorist_save_case_atomic", "rpc", fakeError("ambiguous", "PGRST000"));
    await expect(addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin)).rejects.toMatchObject({ code: "CASE_ATTACHMENT_UNCONFIRMED" });
    expect((await addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin)).mutationId).toBe(mutationId);
    expect(f.storage.download).toHaveBeenCalled(); expect(f.storage.remove).not.toHaveBeenCalled();
  });
  it.each(["metadata", "bytes", "note", "revision"])("rejects collision with different %s without committing or deleting", async difference => {
    const f = fixture(); f.db.failNext("motorist_save_case_atomic", "rpc", fakeError("uncertain", "PGRST000"));
    await expect(addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin)).rejects.toBeDefined();
    let changed = upload;
    if (difference === "metadata") f.stored.metadata = {};
    if (difference === "bytes") f.stored.bytes = new Uint8Array([1, 2]);
    if (difference === "note") changed = { ...upload, command: { ...command, note: "changed" } };
    if (difference === "revision") { changed = { ...upload, command: { ...command, expectedUpdatedAt: committed } }; f.db.update("motorist_cases", { updated_at: committed }, () => true); }
    f.db.log.length = 0;
    await expect(addMobileCaseAttachment(actor, caseId, changed, undefined, f.admin)).rejects.toMatchObject({ code: "CASE_ATTACHMENT_STORAGE_MISMATCH" });
    expect(f.db.log.some(e => e.table === "motorist_save_case_atomic")).toBe(false); expect(f.storage.remove).not.toHaveBeenCalled();
  });
  it("binds exact payload on durable receipt replay", async () => {
    const f = fixture(); await addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin);
    await expect(addMobileCaseAttachment(actor, caseId, { ...upload, command: { ...command, note: "different" } }, undefined, f.admin)).rejects.toMatchObject({ status: 422, code: "CASE_MUTATION_MISMATCH" });
    expect(f.storage.upload).toHaveBeenCalledTimes(1);
  });
  it("cancels an oversized stored stream despite matching metadata size", async () => {
    const f = fixture(), cancel = vi.fn();
    f.storage.download.mockReturnValueOnce({ asStream: async () => ({ data: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MOBILE_CASE_ATTACHMENT_MAX_BYTES + 1)); }, cancel }), error: null }) });
    await expect(addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin)).rejects.toMatchObject({ code: "CASE_ATTACHMENT_STORAGE_MISMATCH" });
    expect(cancel).toHaveBeenCalled(); expect(f.db.log.some(e => e.table === "motorist_save_case_atomic")).toBe(false); expect(f.storage.remove).not.toHaveBeenCalled();
  });
  it("checks same-size actual hash rather than metadata or declared length alone", async () => {
    const f = fixture();
    f.storage.download.mockReturnValueOnce({ asStream: async () => ({ data: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(bytes.length)); controller.close(); } }), error: null }) });
    await expect(addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin)).rejects.toMatchObject({ code: "CASE_ATTACHMENT_STORAGE_MISMATCH" });
    expect(f.storage.remove).not.toHaveBeenCalled();
  });
  it("retains object after a concurrent revision conflict at atomic append", async () => {
    const f = fixture(); f.db.failNext("motorist_save_case_atomic", "rpc", fakeError("changed", "PT409"));
    await expect(addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin)).rejects.toMatchObject({ code: "CASE_REVISION_CONFLICT" });
    expect(f.stored.bytes).toEqual(bytes); expect(f.storage.remove).not.toHaveBeenCalled();
  });
  it("refuses malformed metadata and the explicit 200 attachment upload limit", async () => {
    const f = fixture(); f.db.update("motorist_cases", { attachments_metadata: { bad: true } }, () => true);
    await expect(addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin)).rejects.toMatchObject({ status: 503 });
    f.db.update("motorist_cases", { updated_at: revision, attachments_metadata: Array.from({ length: 200 }, (_, index) => ({ id: id(index + 100) })) }, () => true);
    await expect(addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin)).rejects.toMatchObject({ code: "CASE_ATTACHMENTS_LIMIT" });
    expect(f.storage.upload).not.toHaveBeenCalled();
  });
  it("denies foreign cases, stale revisions and ID collisions before upload", async () => {
    const f = fixture(); f.db.update("motorist_cases", { organization_id: id(99) }, () => true);
    await expect(addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin)).rejects.toMatchObject({ status: 404 });
    f.db.update("motorist_cases", { organization_id: actor.organizationId, updated_at: committed }, () => true);
    await expect(addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin)).rejects.toMatchObject({ code: "CASE_REVISION_CONFLICT" });
    f.db.update("motorist_cases", { updated_at: revision, attachments_metadata: [{ id: mutationId }] }, () => true);
    await expect(addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin)).rejects.toMatchObject({ status: 422 });
    expect(f.storage.upload).not.toHaveBeenCalled();
  });
  it.each(["id", "organization", "revision", "oldRevision", "attachment", "fileName", "storagePath", "storageBucket", "mimeType", "note", "sizeBytes", "createdAt"])("never returns success for corrupted confirmed %s", async field => {
    const f = fixture(); await addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin);
    const row = f.receipts.get(mutationId)!.row;
    if (field === "id") row.id = id(90);
    if (field === "organization") row.organization_id = id(90);
    if (field === "revision") row.updated_at = "bad";
    if (field === "attachment") row.attachments_metadata = [];
    if (field === "oldRevision") row.updated_at = revision;
    if (["fileName", "storagePath", "storageBucket", "mimeType", "note", "sizeBytes", "createdAt"].includes(field)) (row.attachments_metadata as FakeRow[])[0][field] = "corrupt";
    await expect(addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin)).rejects.toMatchObject({ code: "CASE_ATTACHMENT_UNCONFIRMED" });
  });
});

describe("private attachment reads/routes", () => {
  it("returns minimal list and signed URL only within configured storage and actor organization", async () => {
    const f = fixture(); await addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin);
    const result = await listMobileCaseAttachments(actor, caseId, undefined, f.admin);
    expect(result.attachments[0]).not.toHaveProperty("storagePath"); expect(result.caseRevision).toBe(committed);
    expect((await downloadMobileCaseAttachment(actor, caseId, mutationId, undefined, f.admin)).url).toContain("https://test-project.supabase.co/");
    f.storage.createSignedUrl.mockResolvedValueOnce({ data: { signedUrl: "https://foreign.supabase.co/file?secret=x" }, error: null });
    await expect(downloadMobileCaseAttachment(actor, caseId, mutationId, undefined, f.admin)).rejects.toMatchObject({ status: 503 });
    f.db.update("motorist_cases", { organization_id: id(99) }, () => true);
    await expect(listMobileCaseAttachments(actor, caseId, undefined, f.admin)).rejects.toMatchObject({ status: 404 });
  });
  it.each(["../escape", "safe/%2e%2e/escape", "safe\\escape", "safe//escape"])("rejects unsafe attachment storage path %s", async suffix => {
    const f = fixture([{ id: mutationId, fileName: "x.jpg", category: "photo", storageBucket: bucket, storagePath: `${actor.organizationId}/cases/${caseId}/${suffix}` }]);
    expect((await listMobileCaseAttachments(actor, caseId, undefined, f.admin)).attachments[0].downloadable).toBe(false);
    await expect(downloadMobileCaseAttachment(actor, caseId, mutationId, undefined, f.admin)).rejects.toMatchObject({ status: 404 });
    expect(f.storage.createSignedUrl).not.toHaveBeenCalled();
  });
  it("reads a legacy null attachment array as empty without writing it", async () => {
    const f = fixture(); f.db.update("motorist_cases", { attachments_metadata: null, updated_at: revision }, () => true); f.db.log.length = 0;
    expect(await listMobileCaseAttachments(actor, caseId, undefined, f.admin)).toEqual({ caseId, caseRevision: revision, attachments: [] });
    expect(f.db.log.every(entry => entry.operation === "select")).toBe(true);
  });
  it.each([undefined, null])("keeps the fixed private bucket for legacy storageBucket=%j", async storageBucket => {
    const f = fixture([{ id: mutationId, fileName: "legacy.jpg", category: "photo", storagePath: path, ...(storageBucket === undefined ? {} : { storageBucket }) }]);
    expect((await listMobileCaseAttachments(actor, caseId, undefined, f.admin)).attachments[0].downloadable).toBe(true);
    expect((await downloadMobileCaseAttachment(actor, caseId, mutationId, undefined, f.admin)).url).toContain(`/object/sign/${bucket}/${path}`);
    expect(f.admin.storage.from).toHaveBeenCalledWith(bucket);
  });
  it("rejects a malformed category rather than coercing it into a typed DTO", async () => {
    const f = fixture([{ id: mutationId, fileName: "photo.jpg", category: ["photo"] }]);
    await expect(listMobileCaseAttachments(actor, caseId, undefined, f.admin)).rejects.toMatchObject({ status: 503 });
  });
  it("fails explicitly for an oversized list rather than hiding attachment rows", async () => {
    const f = fixture(Array.from({ length: 201 }, (_, index) => ({ id: id(index + 100), fileName: "x", category: "document" })));
    await expect(listMobileCaseAttachments(actor, caseId, undefined, f.admin)).rejects.toMatchObject({ code: "CASE_ATTACHMENTS_LIMIT" });
  });
  it("rejects signed URL path/token manipulation and foreign buckets", async () => {
    const f = fixture(); await addMobileCaseAttachment(actor, caseId, upload, undefined, f.admin);
    for (const url of ["https://test-project.supabase.co/storage/v1/object/sign/other/path?token=x", `https://test-project.supabase.co/storage/v1/object/sign/${bucket}/${path}`, `https://user:pass@test-project.supabase.co/storage/v1/object/sign/${bucket}/${path}?token=x`]) {
      f.storage.createSignedUrl.mockResolvedValueOnce({ data: { signedUrl: url }, error: null });
      await expect(downloadMobileCaseAttachment(actor, caseId, mutationId, undefined, f.admin)).rejects.toMatchObject({ status: 503 });
    }
    f.db.update("motorist_cases", { attachments_metadata: [{ id: mutationId, fileName: "x", category: "document", storageBucket: "foreign", storagePath: path }] }, () => true);
    await expect(downloadMobileCaseAttachment(actor, caseId, mutationId, undefined, f.admin)).rejects.toMatchObject({ status: 404 });
  });
  it("authenticates download before accessing case or storage", async () => {
    const f = fixture(); mocks.actor.mockRejectedValue(new MutationError("login", 401));
    const response = await DOWNLOAD(new Request("https://app.test"), { params: Promise.resolve({ id: caseId, attachmentId: mutationId }) });
    expect(response.status).toBe(401); expect(f.db.log).toHaveLength(0); expect(f.storage.createSignedUrl).not.toHaveBeenCalled();
  });
  it("authenticates before reading body/case and preserves private Bearer semantics", async () => {
    const f = fixture(); mocks.actor.mockRejectedValue(new MutationError("login", 401));
    const response = await POST(request({ forged: true }), { params: Promise.resolve({ id: caseId }) });
    expect(response.status).toBe(401); expect(response.headers.get("www-authenticate")).toBe("Bearer"); expect(response.headers.get("cache-control")).toContain("no-store"); expect(f.db.log).toHaveLength(0);
  });
  it("returns scoped read and confirmed write envelopes", async () => {
    fixture(); const response = await POST(request(), { params: Promise.resolve({ id: caseId }) });
    expect(response.status).toBe(201); expect(await response.json()).toMatchObject({ ok: true, environment: "test", profileId: actor.profileId, mutationId, refreshRequired: true });
    const list = await GET(new Request("https://app.test"), { params: Promise.resolve({ id: caseId }) });
    expect(list.status).toBe(200); expect(list.headers.get("vary")).toContain("Authorization");
  });
});
