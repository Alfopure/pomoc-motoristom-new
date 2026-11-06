import { describe, expect, it, vi } from "vitest";
import type { MobileConfig } from "../lib/config";
import { createEmployeeTasksApi, employeeTask, taskCommandInput, taskCreateInput } from "./api";
import { commandId, orgId, otherId, receipt, scope, task, taskId, userId } from "./fixtures.test-helper";

const config: MobileConfig = { environment: "test", apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "sb_publishable_fixture" };
const attachment = { id: otherId, fileName: "kontrola.jpg", mimeType: "image/jpeg" as const, sizeBytes: 4, createdAt: scope.checkedAt, canRemove: true };
const prepare = { commandId, expectedRevision: 1, attachmentId: otherId, fileName: attachment.fileName, mimeType: attachment.mimeType, sizeBytes: 4 };
const grant = { ...scope, receipt: receipt(), attachment, upload: { url: config.supabaseUrl + "/storage/v1/object/upload/sign/task-photos/image?token=ephemeral", token: "ephemeral", path: "task-photos/image", method: "PUT", contentType: "image/jpeg" } };
function fixture(body: unknown, status = 200) {
  const transport = vi.fn(async (_url: string, _init: RequestInit) => Response.json(body, { status }));
  return { api: createEmployeeTasksApi(config, async () => "fixture-token", userId, orgId, transport), transport };
}

describe("employee task extensions", () => {
  it("sends a real due filter and refuses a response for the unfiltered list", async () => {
    const f = fixture({ ...scope, view: "mine", dueFilter: "overdue", timeZone: "Europe/Bratislava", tasks: [task], nextCursor: null });
    await f.api.list({ view: "mine", category: "open", dueFilter: "overdue", q: "" });
    expect(f.transport.mock.calls[0][0]).toContain("dueFilter=overdue");
    await expect(fixture({ ...scope, view: "mine", tasks: [task], nextCursor: null }).api.list({ view: "mine", category: "open", dueFilter: "today", q: "" })).rejects.toMatchObject({ status: 502 });
  });
  it("validates checklist identities, completion confirmation and org-selected recurrence", () => {
    const input = { commandId, title: "Kontrola", target: { kind: "person", userId }, checklist: [{ id: otherId, title: "Doklady", done: false }], recurrence: { frequency: "weekly", time: "08:30", weekday: 1 } };
    expect(taskCreateInput(input)).toMatchObject({ checklist: input.checklist, recurrence: input.recurrence });
    expect(() => taskCreateInput({ ...input, checklist: [...input.checklist, ...input.checklist] })).toThrow();
    expect(() => taskCreateInput({ ...input, checklist: [{ id: otherId, title: "x".repeat(301), done: false }] })).toThrow();
    expect(() => taskCreateInput({ ...input, recurrence: { frequency: "daily", time: "09:00", timeZone: "Other" } })).toThrow();
    expect(() => taskCreateInput({ ...input, recurrence: { frequency: "weekly", time: "25:00", weekday: 8 } })).toThrow();
    for (const action of ["complete", "approve"]) {
      expect(taskCommandInput({ action, commandId, expectedRevision: 2, allowIncompleteChecklist: true })).toMatchObject({ allowIncompleteChecklist: true });
      expect(() => taskCommandInput({ action, commandId, expectedRevision: 2, allowIncompleteChecklist: "true" })).toThrow();
    }
    expect(taskCommandInput({ action: "recurrence", commandId, expectedRevision: 2, expectedSeriesRevision: 3, schedule: null })).toMatchObject({ schedule: null });
  });
  it("rejects malformed extension projections and optional permissions", () => {
    expect(() => employeeTask({ ...task, checklist: [{ id: otherId, title: "", done: false }] })).toThrow();
    expect(() => employeeTask({ ...task, attachments: [attachment, attachment] })).toThrow();
    expect(() => employeeTask({ ...task, permissions: { ...task.permissions, attach: "yes" } })).toThrow();
    expect(() => employeeTask({ ...task, recurrence: { id: otherId, frequency: "daily", time: "09:00", weekday: null, timeZone: "Invalid", state: "active" } })).toThrow();
  });
  it("prepares photos only for the same immutable upload path and bounded input", async () => {
    const f = fixture(grant, 201);
    expect(await f.api.photoPrepare!(taskId, prepare)).toMatchObject({ attachment });
    await expect(fixture({ ...grant, upload: { ...grant.upload, url: "https://other.invalid/storage/v1/object/upload/sign/a" } }, 201).api.photoPrepare!(taskId, prepare)).rejects.toMatchObject({ status: 502 });
    await expect(f.api.photoPrepare!(taskId, { ...prepare, fileName: "../photo.jpg" })).rejects.toMatchObject({ status: 400 });
    await expect(f.api.photoPrepare!(taskId, { ...prepare, fileName: "ž".repeat(121) })).rejects.toMatchObject({ status: 400 });
    await expect(f.api.photoPrepare!(taskId, { ...prepare, sizeBytes: 8 * 1024 * 1024 + 1 })).rejects.toMatchObject({ status: 400 });
  });
  it("requires the confirmed attachment and checks removal actually removed it", async () => {
    const confirmed = fixture({ ...receipt(), task: { ...task, attachments: [attachment] } });
    await confirmed.api.photoConfirm!(taskId, otherId, { commandId, expectedRevision: 2 });
    await expect(fixture(receipt()).api.photoConfirm!(taskId, otherId, { commandId, expectedRevision: 2 })).rejects.toMatchObject({ status: 502 });
    await expect(fixture(receipt()).api.photoRemove!(taskId, otherId, { commandId, expectedRevision: 2 })).rejects.toMatchObject({ status: 502 });
    await expect(fixture({ ...receipt(), task: { ...task, attachments: [] } }).api.photoRemove!(taskId, otherId, { commandId, expectedRevision: 2 })).resolves.toMatchObject({ task: { attachments: [] } });
    await expect(confirmed.api.photoRemove!(taskId, otherId, { commandId, expectedRevision: 2 })).rejects.toMatchObject({ status: 502 });
  });
  it("uploads no bearer or cookies to Storage and reconciles an already uploaded object", async () => {
    const transport = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ message: "The resource already exists" }, { status: 409 }));
    const api = createEmployeeTasksApi(config, async () => "never-to-storage", userId, orgId, transport);
    await api.photoUpload!(grant as Parameters<NonNullable<typeof api.photoUpload>>[0], new Uint8Array([255, 216, 255, 1]));
    expect(transport.mock.calls[0][1]).toMatchObject({ method: "PUT", credentials: "omit", headers: { "Content-Type": "image/jpeg", "x-upsert": "false" } });
    expect(transport.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
  });
});
