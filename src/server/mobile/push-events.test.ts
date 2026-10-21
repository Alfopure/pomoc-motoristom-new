import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";
import { callbackPushText, pushCaseAssigned, pushTaskAssigned, pushTaskDue, pushTaskReview, runMobileCallbackPush } from "./push-events";

const queued: (() => Promise<unknown>)[] = [];
vi.mock("next/server", () => ({ after: (work: () => Promise<unknown>) => { queued.push(work); } }));
vi.mock("./auth", () => ({ mobileEnvironment: () => "test" }));

const ORG = "00000000-0000-4000-8000-0000000000a1";
const ME = "00000000-0000-4000-8000-000000000001";
const COLLEAGUE = "00000000-0000-4000-8000-000000000002";
const TASK = "00000000-0000-4000-8000-0000000000b1";
const CASE = "00000000-0000-4000-8000-0000000000c1";
const NOW = new Date("2026-10-21T10:00:00.000Z");
const token = (suffix: string) => "ExponentPushToken[" + suffix.padEnd(12, "x") + "]";

let fake: FakeSupabase;
let sent: { to: string; title: string; body: string; data: unknown }[];
const transport = vi.fn(async (_url: string, init: RequestInit) => {
  const batch = JSON.parse(String(init.body)) as typeof sent;
  sent.push(...batch);
  return new Response(JSON.stringify({ data: batch.map(() => ({ status: "ok" })) }), { status: 200 });
});
async function drain() {
  while (queued.length) await queued.shift()!();
}

beforeEach(() => {
  fake = createFakeSupabase({ now: () => NOW, uniqueKeys: { motorist_mobile_push_devices: [["id"], ["environment", "installation_id"], ["expo_push_token"]] } });
  fake.db.seed("motorist_profiles", [
    { id: ME, organization_id: ORG, active: true, access_status: "active", role: "dispatcher", kind: "human" },
    { id: COLLEAGUE, organization_id: ORG, active: true, access_status: "active", role: "dispatcher", kind: "human" },
  ]);
  const seen = NOW.toISOString();
  fake.db.seed("motorist_mobile_push_devices", [ME, COLLEAGUE].map((profileId, index) => ({
    organization_id: ORG, profile_id: profileId, environment: "test", installation_id: "00000000-0000-4000-8000-0000000000f" + index,
    expo_push_token: token(profileId === ME ? "mine" : "theirs"), platform: "ios", preferences: {}, app_version: null, created_at: seen, updated_at: seen, last_seen_at: seen,
  })));
  fake.db.seed("motorist_cases", [{ id: CASE, organization_id: ORG, case_number: "PM-2026-0042" }]);
  sent = [];
  queued.length = 0;
  transport.mockClear();
  vi.stubGlobal("fetch", transport);
  vi.stubEnv("MOBILE_PUSH_ENABLED", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("task and case events", () => {
  it("announces an assignment with the case number and due time, never the task title", async () => {
    fake.db.seed("motorist_case_tasks", [{ id: TASK, organization_id: ORG, case_id: CASE, title: "Zavolať pánovi Novákovi 0905 123 456", due_at: "2026-10-21T12:30:00.000Z", status: "open", assigned_to: ME }]);
    pushTaskAssigned(fake.admin, { organizationId: ORG, notificationId: "n1", taskId: TASK, recipientProfileId: ME });
    pushTaskAssigned(fake.admin, { organizationId: ORG, notificationId: "n1", taskId: TASK, recipientProfileId: ME });
    await drain();
    expect(sent).toEqual([{ to: token("mine"), title: "Nová úloha", body: "Máte pridelenú úlohu k prípadu PM-2026-0042, termín 21. 10. 14:30.", data: { kind: "task", id: TASK, profileId: ME }, sound: "default", priority: "high" }]);
    expect(JSON.stringify(sent)).not.toContain("Novák");
  });

  it("stays quiet for a task its creator gave to themselves, but not when it comes back to them later", async () => {
    fake.db.seed("motorist_case_tasks", [{ id: TASK, organization_id: ORG, case_id: null, title: "x", due_at: null, status: "open", assigned_to: ME, created_by: ME, assignment_generation: 0 }]);
    pushTaskAssigned(fake.admin, { organizationId: ORG, notificationId: "n1", taskId: TASK, recipientProfileId: ME });
    await drain();
    expect(sent).toEqual([]);
    fake.db.storage("motorist_case_tasks")[0].assignment_generation = 2;
    pushTaskAssigned(fake.admin, { organizationId: ORG, notificationId: "n2", taskId: TASK, recipientProfileId: ME });
    await drain();
    expect(sent.map(item => item.title)).toEqual(["Nová úloha"]);
  });

  it("stays quiet when the task was reassigned or finished in the meantime", async () => {
    fake.db.seed("motorist_case_tasks", [{ id: TASK, organization_id: ORG, case_id: null, title: "x", due_at: null, status: "open", assigned_to: COLLEAGUE }]);
    pushTaskAssigned(fake.admin, { organizationId: ORG, notificationId: "n1", taskId: TASK, recipientProfileId: ME });
    await drain();
    expect(sent).toEqual([]);
  });

  it("reminds of a due or overdue task", async () => {
    pushTaskDue(fake.admin, { organizationId: ORG, notificationId: "r1", taskId: TASK, recipientProfileId: ME, caseNumber: "PM-2026-0042", dueAt: "2026-10-21T12:30:00.000Z", now: NOW });
    pushTaskDue(fake.admin, { organizationId: ORG, notificationId: "r2", taskId: TASK, recipientProfileId: ME, caseNumber: null, dueAt: "2026-10-21T09:00:00.000Z", now: NOW });
    await drain();
    expect(sent.map(item => [item.title, item.body])).toEqual([
      ["Pripomienka úlohy", "Úloha k prípadu PM-2026-0042 má termín 21. 10. 14:30."],
      ["Úloha po termíne", "Úloha je po termíne."],
    ]);
  });

  it("tells the reviewer about a handed-over task and the assignee about a return", async () => {
    fake.db.seed("motorist_notifications", [
      { id: "00000000-0000-4000-8000-0000000000d1", organization_id: ORG, task_id: TASK, case_id: CASE, recipient_profile_id: COLLEAGUE, status: "unread", created_at: NOW.toISOString(),
        dedupe_key: "task-review:" + TASK + ":generation:1:submit_review:recipient:" + COLLEAGUE },
      { id: "00000000-0000-4000-8000-0000000000d2", organization_id: ORG, task_id: TASK, case_id: null, recipient_profile_id: ME, status: "unread", created_at: NOW.toISOString(),
        dedupe_key: "task-review:" + TASK + ":generation:1:return:recipient:" + ME },
    ]);
    pushTaskReview(fake.admin, { organizationId: ORG, taskId: TASK, action: "submit_review" });
    pushTaskReview(fake.admin, { organizationId: ORG, taskId: TASK, action: "return" });
    pushTaskReview(fake.admin, { organizationId: ORG, taskId: TASK, action: "approve" });
    await drain();
    expect(sent.map(item => [item.to, item.title, item.body])).toEqual([
      [token("theirs"), "Úloha na kontrolu", "Kolega vám poslal úlohu k prípadu PM-2026-0042 na kontrolu."],
      [token("mine"), "Úloha vrátená na dopracovanie", "Kontrolór vám vrátil úlohu."],
    ]);
  });

  it("notifies a newly assigned dispatcher of a case, but not someone who took it", async () => {
    pushCaseAssigned(fake.admin, { organizationId: ORG, caseId: CASE, ownerId: ME, actorProfileId: ME, committedRevision: "2026-10-21T10:00:00.000Z" });
    expect(queued).toHaveLength(0);
    pushCaseAssigned(fake.admin, { organizationId: ORG, caseId: CASE, ownerId: COLLEAGUE, actorProfileId: ME, committedRevision: "2026-10-21T10:00:00.000Z" });
    pushCaseAssigned(fake.admin, { organizationId: ORG, caseId: CASE, ownerId: COLLEAGUE, actorProfileId: ME, committedRevision: "2026-10-21T10:00:00.000Z" });
    await drain();
    expect(sent).toEqual([{ to: token("theirs"), title: "Pridelený prípad", body: "Kolega vám pridelil prípad PM-2026-0042.", data: { kind: "case", id: CASE, profileId: COLLEAGUE }, sound: "default", priority: "high" }]);
  });

  it("queues nothing where push is off", () => {
    vi.stubEnv("MOBILE_PUSH_ENABLED", "");
    pushCaseAssigned(fake.admin, { organizationId: ORG, caseId: CASE, ownerId: COLLEAGUE, actorProfileId: ME, committedRevision: "r" });
    pushTaskDue(fake.admin, { organizationId: ORG, notificationId: "r1", taskId: TASK, recipientProfileId: ME, caseNumber: null, dueAt: null, now: NOW });
    expect(queued).toHaveLength(0);
  });
});

describe("overdue callbacks", () => {
  const callback = (id: string, values: Record<string, unknown>) => ({ id, organization_id: ORG, caller_number: "+421905123456", source: "missed", status: "open",
    claimed_by: null, due_at: null, created_at: "2026-10-21T09:00:00.000Z", ...values });

  it("counts in Slovak", () => {
    expect(callbackPushText("callbacks_unclaimed", 1).body).toBe("Požiadavka na spätné volanie je po termíne a nikto ju neprevzal.");
    expect(callbackPushText("callbacks_unclaimed", 3).body).toBe("3 požiadavky na spätné volanie sú po termíne a nikto ich neprevzal.");
    expect(callbackPushText("callbacks_unclaimed", 7).body).toBe("7 požiadaviek na spätné volanie je po termíne a nikto ich neprevzal.");
    expect(callbackPushText("callbacks_mine", 2).body).toBe("2 vaše prevzaté spätné volania čakajú na zavolanie.");
    expect(callbackPushText("callbacks_mine", 5).body).toBe("5 vašich prevzatých spätných volaní čaká na zavolanie.");
  });

  it("alerts the claimer about their callback and everyone about unclaimed ones, once per deadline", async () => {
    fake.db.seed("motorist_callback_requests", [
      callback("00000000-0000-4000-8000-0000000000e1", { claimed_by: ME, due_at: "2026-10-21T09:50:00.000Z", status: "scheduled" }),
      callback("00000000-0000-4000-8000-0000000000e2", { created_at: "2026-10-21T09:20:00.000Z" }),
      callback("00000000-0000-4000-8000-0000000000e3", { due_at: "2026-10-21T09:55:00.000Z" }),
      // Not yet due, too old, or settled: no alert.
      callback("00000000-0000-4000-8000-0000000000e4", { created_at: "2026-10-21T09:45:00.000Z" }),
      callback("00000000-0000-4000-8000-0000000000e5", { due_at: "2026-10-21T10:30:00.000Z" }),
      callback("00000000-0000-4000-8000-0000000000e6", { due_at: "2026-10-20T20:00:00.000Z" }),
      callback("00000000-0000-4000-8000-0000000000e7", { due_at: "2026-10-21T09:40:00.000Z", status: "done" }),
    ]);
    await expect(runMobileCallbackPush(fake.admin, ORG, NOW, transport)).resolves.toEqual({ status: "ok", detail: { overdue: 3, announced: 3, sent: 3, failed: 0 } });
    // One archived row per callback deadline, not per person.
    expect(fake.db.storage("motorist_notifications").map(row => row.dedupe_key).sort()).toEqual([
      "mobile-push:callback-overdue:00000000-0000-4000-8000-0000000000e1:" + Date.parse("2026-10-21T09:50:00.000Z"),
      "mobile-push:callback-overdue:00000000-0000-4000-8000-0000000000e2:" + Date.parse("2026-10-21T09:50:00.000Z"),
      "mobile-push:callback-overdue:00000000-0000-4000-8000-0000000000e3:" + Date.parse("2026-10-21T09:55:00.000Z"),
    ].sort());
    expect(sent.map(item => [item.to, item.title, item.body]).sort()).toEqual([
      [token("mine"), "Spätné volania bez dispečera", "2 požiadavky na spätné volanie sú po termíne a nikto ich neprevzal."],
      [token("mine"), "Spätné volanie po termíne", "Vaše prevzaté spätné volanie čaká na zavolanie."],
      [token("theirs"), "Spätné volania bez dispečera", "2 požiadavky na spätné volanie sú po termíne a nikto ich neprevzal."],
    ].sort());
    expect(sent.every(item => (item.data as { kind: string }).kind === "callbacks" && !item.body.includes("905"))).toBe(true);
    expect(sent.map(item => (item.data as { profileId: string }).profileId).sort()).toEqual([ME, ME, COLLEAGUE].sort());

    sent = [];
    await expect(runMobileCallbackPush(fake.admin, ORG, new Date(NOW.getTime() + 5 * 60_000), transport)).resolves.toMatchObject({ status: "ok", detail: { sent: 0 } });
    expect(sent).toEqual([]);
  });

  it("announces a rescheduled callback again", async () => {
    fake.db.seed("motorist_callback_requests", [callback("00000000-0000-4000-8000-0000000000e1", { claimed_by: ME, due_at: "2026-10-21T09:50:00.000Z" })]);
    await runMobileCallbackPush(fake.admin, ORG, NOW, transport);
    fake.db.storage("motorist_callback_requests")[0].due_at = "2026-10-21T10:20:00.000Z";
    await runMobileCallbackPush(fake.admin, ORG, new Date("2026-10-21T10:25:00.000Z"), transport);
    expect(sent.map(item => item.title)).toEqual(["Spätné volanie po termíne", "Spätné volanie po termíne"]);
  });

  it("respects the switches and does nothing where push is off", async () => {
    fake.db.seed("motorist_callback_requests", [callback("00000000-0000-4000-8000-0000000000e2", { created_at: "2026-10-21T09:20:00.000Z" })]);
    for (const row of fake.db.storage("motorist_mobile_push_devices")) row.preferences = { callbacks_unclaimed: false };
    await expect(runMobileCallbackPush(fake.admin, ORG, NOW, transport)).resolves.toEqual({ status: "ok", detail: { overdue: 1, announced: 0, sent: 0, failed: 0 } });
    expect(transport).not.toHaveBeenCalled();
    // Switched on later within the window, the same callback is still announced.
    for (const row of fake.db.storage("motorist_mobile_push_devices")) row.preferences = {};
    await expect(runMobileCallbackPush(fake.admin, ORG, NOW, transport)).resolves.toMatchObject({ detail: { announced: 1, sent: 2 } });
    vi.stubEnv("MOBILE_PUSH_ENABLED", "");
    await expect(runMobileCallbackPush(fake.admin, ORG, NOW, transport)).resolves.toEqual({ status: "disabled", detail: { reason: "push_disabled" } });
  });

  it("tries again on the next pass when the push service reached nobody", async () => {
    fake.db.seed("motorist_callback_requests", [callback("00000000-0000-4000-8000-0000000000e1", { claimed_by: ME, due_at: "2026-10-21T09:50:00.000Z" })]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const down = vi.fn(async () => new Response("down", { status: 502 }));
    await expect(runMobileCallbackPush(fake.admin, ORG, NOW, down)).resolves.toMatchObject({ detail: { announced: 1, sent: 0, failed: 1 } });
    expect(fake.db.storage("motorist_notifications")).toEqual([]);
    await expect(runMobileCallbackPush(fake.admin, ORG, new Date(NOW.getTime() + 5 * 60_000), transport)).resolves.toMatchObject({ detail: { announced: 1, sent: 1 } });
    expect(sent.map(item => item.title)).toEqual(["Spätné volanie po termíne"]);
    warn.mockRestore();
  });

  it("fails the job when the callbacks cannot be read", async () => {
    fake.db.failNext("motorist_callback_requests", "select", "down");
    await expect(runMobileCallbackPush(fake.admin, ORG, NOW, transport)).rejects.toThrow("Overdue callbacks unavailable");
  });
});
