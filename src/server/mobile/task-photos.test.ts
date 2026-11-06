import { beforeEach, describe, expect, it, vi } from "vitest";
import { MutationError } from "@/server/mutation-error";
import { TASK_PHOTO_MAX_BYTES } from "@/lib/mobile-task-workspace";
const mocks = vi.hoisted(() => ({ call: vi.fn(), actor: vi.fn(), signedUpload: vi.fn(), signedRead: vi.fn(), info: vi.fn(), stream: vi.fn(), remove: vi.fn() }));
vi.mock("./auth", () => ({ mobileEnvironment: () => "test" }));
vi.mock("./employee-tasks", async original => {
  const actual = await original<typeof import("./employee-tasks")>();
  return { ...actual, callEmployeeTask: mocks.call, requireEmployeeTaskUser: mocks.actor };
});
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ storage: { from: () => ({ createSignedUploadUrl: mocks.signedUpload, createSignedUrl: mocks.signedRead,
  info: mocks.info, download: () => ({ asStream: mocks.stream }), remove: mocks.remove }) } }) }));
vi.mock("@/lib/supabase/env", () => ({ getSupabasePublicEnv: () => ({ url: "https://nzpnqdstvkfncflgqlny.supabase.co", publicKey: "public" }) }));
import { confirmTaskAttachment, downloadTaskAttachment, parseTaskAttachmentPrepare, prepareTaskAttachment, removeTaskAttachment } from "./task-photos";
import { POST as prepareRoute } from "@/app/api/mobile/v1/tasks/workspace/[id]/photos/route";
import { GET as readRoute, DELETE as removeRoute } from "@/app/api/mobile/v1/tasks/workspace/[id]/photos/[photoId]/route";
import { POST as confirmRoute } from "@/app/api/mobile/v1/tasks/workspace/[id]/photos/[photoId]/confirm/route";
const ORG = "20000000-0000-4000-8000-000000000001", USER = "10000000-0000-4000-8000-000000000001", TASK = "30000000-0000-4000-8000-000000000001";
const PHOTO = "40000000-0000-4000-8000-000000000001", COMMAND = "50000000-0000-4000-8000-000000000001", AT = "2026-11-06T12:00:00Z";
const path = `${ORG}/${TASK}/${PHOTO}.jpg`, origin = "https://nzpnqdstvkfncflgqlny.supabase.co", bucket = "motorist-task-photos";
const actor = { userId: USER, organizationId: ORG }, command = { commandId: COMMAND, expectedRevision: 1 };
const attachment = () => ({ id: PHOTO, fileName: "foto.jpg", mimeType: "image/jpeg", sizeBytes: 4, createdAt: AT, bucket, path, status: "pending", canRemove: true });
const task = () => ({ id: TASK, title: "Foto", description: "", state: "todo", priority: "normal", dueAt: null, revision: 2, createdAt: AT, updatedAt: AT,
  createdBy: { userId: USER, displayName: "Zamestnanec" }, assignee: null, group: null, reviewer: null, caseLinks: [], reviewSubmission: null, reviewReturnReason: null,
  permissions: { start: false, complete: false, reopen: false, claim: false, assign: false, comment: true, submitReview: false, approve: false, return: false } });
const receipt = () => ({ commandId: COMMAND, committedRevision: 2, task: task(), attachmentUpload: attachment() });
const prepare = () => ({ ...command, attachmentId: PHOTO, fileName: "foto.jpg", mimeType: "image/jpeg", sizeBytes: 4 });
beforeEach(() => {
  vi.clearAllMocks(); mocks.actor.mockResolvedValue(actor);
  mocks.call.mockImplementation(async (_actor: unknown, action: string) => action === "attachment" ? { attachment: attachment() } : receipt());
  mocks.signedUpload.mockResolvedValue({ data: { path, token: "opaque", signedUrl: `${origin}/storage/v1/object/upload/sign/${bucket}/${path}?token=opaque` }, error: null });
  mocks.signedRead.mockResolvedValue({ data: { signedUrl: `${origin}/storage/v1/object/sign/${bucket}/${path}?token=opaque` }, error: null });
  mocks.info.mockResolvedValue({ data: { name: path, bucketId: bucket, contentType: "image/jpeg", size: 4 }, error: null });
  mocks.stream.mockImplementation(async () => ({ data: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([255, 216, 255, 0])); controller.close(); } }), error: null }));
  mocks.remove.mockResolvedValue({ data: [], error: null });
});
describe("private employee task photographs", () => {
  it.each([0, TASK_PHOTO_MAX_BYTES + 1, 1.5])("rejects invalid size %s before intent", sizeBytes => {
    expect(() => parseTaskAttachmentPrepare({ ...prepare(), sizeBytes })).toThrow(); expect(mocks.call).not.toHaveBeenCalled();
  });
  it.each(["../secret.jpg", "foto/one.jpg", "a\\b.jpg", "a\u0000.jpg"])("rejects unsafe file name %s", fileName => {
    expect(() => parseTaskAttachmentPrepare({ ...prepare(), fileName })).toThrow();
  });
  it("creates only a signed immutable upload in this task and strips internal metadata", async () => {
    const result = await prepareTaskAttachment(actor, TASK, prepare());
    expect(result).toMatchObject({ userId: USER, organizationId: ORG, attachment: { id: PHOTO, sizeBytes: 4 }, upload: { method: "PUT", contentType: "image/jpeg", path } });
    expect(mocks.signedUpload).toHaveBeenCalledWith(path, { upsert: false });
    expect(result.attachment).not.toHaveProperty("bucket"); expect(result.attachment).not.toHaveProperty("path");
  });
  it("does not renew an upload token after its locked grant is denied or no longer pending", async () => {
    mocks.call.mockResolvedValueOnce(receipt()).mockRejectedValueOnce(new MutationError("expired", 404));
    await expect(prepareTaskAttachment(actor, TASK, prepare())).rejects.toMatchObject({ status: 404 });
    expect(mocks.signedUpload).not.toHaveBeenCalled();
    mocks.call.mockResolvedValueOnce(receipt()).mockResolvedValueOnce({ attachmentUpload: { ...attachment(), status: "ready" } });
    await expect(prepareTaskAttachment(actor, TASK, prepare())).rejects.toMatchObject({ status: 503 });
    expect(mocks.signedUpload).not.toHaveBeenCalled();
  });
  it("does not sign a path outside the authorized organization or a foreign provider origin", async () => {
    mocks.call.mockResolvedValueOnce(receipt()).mockResolvedValueOnce({ attachmentUpload: { ...attachment(), path: `other/${path}` } });
    await expect(prepareTaskAttachment(actor, TASK, prepare())).rejects.toMatchObject({ status: 503 }); expect(mocks.signedUpload).not.toHaveBeenCalled();
    mocks.signedUpload.mockResolvedValueOnce({ data: { path, token: "opaque", signedUrl: `https://foreign.example/storage/v1/object/upload/sign/${bucket}/${path}?token=opaque` } });
    await expect(prepareTaskAttachment(actor, TASK, prepare())).rejects.toMatchObject({ status: 503 });
  });
  it("confirms only after provider metadata, actual length and image signature match", async () => {
    expect((await confirmTaskAttachment(actor, TASK, PHOTO, command)).task.id).toBe(TASK);
    expect(mocks.call).toHaveBeenLastCalledWith(actor, "command", TASK, { ...command, action: "attachment_finish", attachmentId: PHOTO });
    mocks.info.mockResolvedValueOnce({ data: { name: path, bucketId: bucket, contentType: "image/png", size: 4 } });
    await expect(confirmTaskAttachment(actor, TASK, PHOTO, command)).rejects.toMatchObject({ status: 422 });
  });
  it("rejects a fake JPEG and never commits it", async () => {
    mocks.stream.mockResolvedValueOnce({ data: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3, 4])); c.close(); } }) });
    await expect(confirmTaskAttachment(actor, TASK, PHOTO, command)).rejects.toMatchObject({ status: 422 });
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });
  it("never offers a pending photograph for download", async () => {
    await expect(downloadTaskAttachment(actor, TASK, PHOTO)).rejects.toMatchObject({ status: 409 }); expect(mocks.signedRead).not.toHaveBeenCalled();
    mocks.call.mockResolvedValueOnce({ attachment: { ...attachment(), status: "ready" } });
    const result = await downloadTaskAttachment(actor, TASK, PHOTO); expect(Date.parse(result.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);
  });
  it("hides removed metadata before object cleanup and leaves provider failures retryable by cleanup", async () => {
    mocks.remove.mockResolvedValueOnce({ error: { message: "offline" } });
    expect((await removeTaskAttachment(actor, TASK, PHOTO, command)).task.id).toBe(TASK);
    expect(mocks.call).toHaveBeenCalledWith(actor, "command", TASK, { ...command, action: "attachment_remove", attachmentId: PHOTO });
    expect(mocks.remove).toHaveBeenCalledWith([path]);
  });
  it("rejects forged confirmation fields and unknown commands", async () => {
    await expect(confirmTaskAttachment(actor, TASK, PHOTO, { ...command, bucket: "other" })).rejects.toMatchObject({ status: 400 });
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it.each([[prepareRoute, "POST"], [readRoute, "GET"], [removeRoute, "DELETE"], [confirmRoute, "POST"]] as const)("route %s requires verified employee before RPC/storage", async (route, method) => {
    mocks.actor.mockRejectedValueOnce(new MutationError("login", 401));
    const response = await route(new Request("https://test.example/photo", { method }), { params: Promise.resolve({ id: TASK, photoId: PHOTO }) });
    expect(response.status).toBe(401); expect(mocks.call).not.toHaveBeenCalled(); expect(mocks.signedRead).not.toHaveBeenCalled();
  });
});
