import { describe, expect, it, vi } from "vitest";
import { createWorkApi } from "./api";
import type { MobileTransport } from "../lib/api";
export const actor = "00000000-0000-4000-8000-000000000001", caseId = "00000000-0000-4000-8000-000000000002", taskId = "00000000-0000-4000-8000-000000000003", commandId = "00000000-0000-4000-8000-000000000004";
export const scope = { ok: true as const, apiVersion: 1 as const, environment: "test" as const, profileId: actor, checkedAt: "2026-10-11T12:00:00.000001Z" };
export const task = { id: taskId, title: "Overiť odťah", status: "open" as const, priority: "normal" as const, kind: "dispatch" as const, revision: 2, workflowState: "todo" as const,
  originLocked: false, assignedTo: null, reviewer: null, dueAt: null, createdAt: scope.checkedAt, updatedAt: scope.checkedAt, createdByMe: true, reviewSubmission: null, reviewReturnReason: null };
const capabilities = { create: true, workflow: true, messages: true };
export const config = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "sb_publishable_fixture" };
function fixture(body: unknown, status = 200) {
  const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json(body, { status }));
  return { transport, api: createWorkApi(config, actor, async () => "token", transport, async () => transport) };
}
describe("case work API contracts", () => {
  it("uses scoped bearer-only task pagination with request start time", async () => {
    const f = fixture({ ...scope, caseId, tasks: [task], nextCursor: "next", capabilities });
    const before = Date.now(), result = await f.api.tasks(caseId, "opaque+/=");
    expect(result.requestedAt).toBeGreaterThanOrEqual(before);
    expect(result.tasks).toEqual([task]);
    const [url, init] = f.transport.mock.calls[0];
    expect(new URL(url).searchParams.get("cursor")).toBe("opaque+/=");
    expect(init).toMatchObject({ credentials: "omit", headers: { Authorization: "Bearer token", "X-PM-App-Environment": "test" } });
  });
  it.each([{ profileId: taskId }, { environment: "production" }, { caseId: taskId }, { tasks: [task, task] }, { nextCursor: "same" }, { capabilities: { create: true } }])("rejects wrong selection/scope or malformed list %j", async change => {
    await expect(fixture({ ...scope, caseId, tasks: [task], nextCursor: null, capabilities, ...change }).api.tasks(caseId, "same")).rejects.toMatchObject({ status: 502 });
  });
  it("requires exact task/command identity and a revision newer than the submitted revision", async () => {
    const command = { action: "start" as const, expectedRevision: 2, commandId };
    const receipt = { ...scope, taskId, commandId, committedRevision: 3, currentRevision: 4, refreshRequired: true };
    expect(await fixture(receipt).api.transition(taskId, command)).toEqual(receipt);
    for (const change of [{ taskId: caseId }, { commandId: taskId }, { committedRevision: 2 }, { currentRevision: 2 }, { refreshRequired: false }]) {
      await expect(fixture({ ...receipt, ...change }).api.transition(taskId, command)).rejects.toMatchObject({ status: 502 });
    }
  });
  it("requires exact actor/task/body/client identity in message receipts", async () => {
    const input = { clientMessageId: commandId, body: "Overené" };
    const message = { id: commandId, taskId, authorProfileId: actor, authorName: "Dispečer", createdAt: scope.checkedAt, ...input };
    expect((await fixture({ ...scope, taskId, message, refreshRequired: true }).api.sendMessage(taskId, input)).message).toEqual(message);
    for (const change of [{ authorProfileId: taskId }, { taskId: caseId }, { body: "iné" }, { clientMessageId: taskId }]) {
      await expect(fixture({ ...scope, taskId, message: { ...message, ...change }, refreshRequired: true }).api.sendMessage(taskId, input)).rejects.toMatchObject({ status: 502 });
    }
  });
  it("keeps server error codes and never retries a POST", async () => {
    const f = fixture({ error: "Uncertain", code: "TASK_CREATE_UNCONFIRMED" }, 503);
    await expect(f.api.createTask(caseId, { title: "X" })).rejects.toMatchObject({ status: 503, code: "TASK_CREATE_UNCONFIRMED" });
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it("rejects duplicate colleagues and invalid task detail", async () => {
    const colleague = { id: actor, name: "Kolega" };
    await expect(fixture({ ...scope, colleagues: [colleague, colleague] }).api.colleagues()).rejects.toMatchObject({ status: 502 });
    await expect(fixture({ ...scope, task: { ...task, id: caseId }, linkedCases: [], capabilities }).api.task(taskId)).rejects.toMatchObject({ status: 502 });
  });
  it("accepts only exact TEST signed asset host without credentials", async () => {
    const receipt = { ...scope, caseId, attachmentId: commandId, url: config.supabaseUrl + "/storage/v1/object/sign/motorist-case-attachments/" + actor + "/cases/" + caseId + "/file?token=opaque", expiresAt: "2099-01-01T00:00:00Z" };
    expect((await fixture(receipt).api.download(caseId, commandId)).url).toBe(receipt.url);
    for (const url of ["https://example.com/file", "https://user:pass@nzpnqdstvkfncflgqlny.supabase.co/storage/v1/object/sign/x", receipt.url.replace("https:", "http:")]) {
      await expect(fixture({ ...receipt, url }).api.download(caseId, commandId)).rejects.toMatchObject({ status: 502 });
    }
  });
});

describe("attachment receipt and signed-path rejection", () => {
  const command = { mutationId: commandId, expectedUpdatedAt: "2026-10-11T12:00:00.123456Z", fileName: "foto.jpg", category: "photo" as const, note: "Údaje" };
  const payload = { bytes: new Uint8Array([1]), contentType: "multipart/form-data; boundary=x", mimeType: "image/jpeg", sizeBytes: 4 };
  const item = { id: commandId, fileName: command.fileName, category: command.category, mimeType: "image/jpeg", sizeBytes: 4, note: command.note, createdAt: scope.checkedAt, downloadable: true };
  const receipt = { ...scope, caseId, mutationId: commandId, attachment: item, committedRevision: "2026-10-11T12:00:00.123457Z", refreshRequired: true };
  it("accepts a one-microsecond advance and verifies MIME/length/filename/note/ID", async () => {
    expect(await fixture(receipt).api.upload(caseId, command, payload)).toEqual(receipt);
    for (const change of [{ id: taskId }, { fileName: "other.jpg" }, { mimeType: "image/png" }, { sizeBytes: 5 }, { note: "different" }]) {
      await expect(fixture({ ...receipt, attachment: { ...item, ...change } }).api.upload(caseId, command, payload)).rejects.toMatchObject({ status: 502 });
    }
    for (const committedRevision of [command.expectedUpdatedAt, "2026-10-11T12:00:00.123455Z"]) await expect(fixture({ ...receipt, committedRevision }).api.upload(caseId, command, payload)).rejects.toMatchObject({ status: 502 });
  });
  it("rejects different bucket/case and encoded traversal/slash while allowing a safe UTF8 object name", async () => {
    const prefix = config.supabaseUrl + "/storage/v1/object/sign/motorist-case-attachments/" + actor + "/cases/" + caseId + "/";
    for (const url of [prefix.replace("motorist-case-attachments", "other") + "file?token=x", prefix.replace(caseId, taskId) + "file?token=x", prefix + "%2e%2e/file?token=x", prefix + "%2fsecret?token=x", prefix + "%252fsecret?token=x"]) {
      await expect(fixture({ ...scope, caseId, attachmentId: commandId, url, expiresAt: "2099-01-01T00:00:00Z" }).api.download(caseId, commandId)).rejects.toMatchObject({ status: 502 });
    }
    const url = prefix + "%C5%BElte.jpg?token=x";
    expect((await fixture({ ...scope, caseId, attachmentId: commandId, url, expiresAt: "2099-01-01T00:00:00Z" }).api.download(caseId, commandId)).url).toBe(url);
  });
  it("message pages use only opaque cursor, no unsupported limit", async () => {
    const f = fixture({ ...scope, taskId, messages: [], nextCursor: null }); await f.api.messages(taskId, "opaque");
    const params = new URL(f.transport.mock.calls[0][0]).searchParams; expect(params.get("cursor")).toBe("opaque"); expect(params.has("limit")).toBe(false);
  });
});
