import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness } from "@/test/telephony-harness";
import { effectsDeps } from "../session-runner";
import { upsertCallRow } from "./effects";
import { type SessionRow } from "./types";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function fixture() {
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  const call = await h.inbound();
  const deps = effectsDeps(h.deps);
  const session = () => h.session(call.sessionId) as SessionRow;
  await upsertCallRow(deps, session(), {});
  h.db.log.length = 0;
  return { h, call, deps, session };
}

describe("fresh call projection writes", () => {
  it("keeps fresh reads but skips an identical projection and still supplies the durable call identity", async () => {
    const t = await fixture();
    t.deps.callIds!.clear();
    const stored = structuredClone(t.h.call(t.call.sessionId));
    if (!stored) throw new Error("fixture call missing");
    await upsertCallRow(t.deps, t.session(), {});
    expect(t.h.call(t.call.sessionId)).toEqual(stored);
    expect(t.h.db.log.filter(row => row.table === "motorist_calls").map(row => row.operation)).toEqual(["select"]);
    expect(t.deps.callIds!.get(t.call.sessionId)).toBe(stored.id);
  });

  it("writes a changed projection once and retains unrelated completed recording status", async () => {
    const t = await fixture();
    t.h.db.update("motorist_calls", { recording_status: "available" }, row => row.session_id === t.call.sessionId);
    await upsertCallRow(t.deps, t.session(), { summary: "Updated operator summary" });
    expect(t.h.call(t.call.sessionId)).toMatchObject({ summary: "Updated operator summary", recording_status: "available" });
    expect(t.h.db.log.filter(row => row.table === "motorist_calls" && row.operation === "update")).toHaveLength(1);
    t.h.db.log.length = 0;
    await upsertCallRow(t.deps, t.session(), { summary: "Updated operator summary" });
    expect(t.h.db.log.some(row => row.table === "motorist_calls" && row.operation === "update")).toBe(false);
  });

  it("recomputes changed nested state rather than trusting a previous history snapshot", async () => {
    const t = await fixture();
    const session = t.session();
    await upsertCallRow(t.deps, { ...session, state: "held" }, {});
    expect(t.h.call(t.call.sessionId)?.raw_latest_payload).toMatchObject({ state: "held" });
    expect(t.h.db.log.filter(row => row.table === "motorist_calls" && row.operation === "update")).toHaveLength(1);
  });

  it("does not turn an unavailable fresh projection into a successful no-op", async () => {
    const t = await fixture();
    t.h.db.failNext("motorist_calls", "select", "database unavailable");
    await expect(upsertCallRow(t.deps, t.session(), {})).rejects.toThrow("call lookup failed");
    expect(t.h.db.log.some(row => row.table === "motorist_calls" && row.operation === "update")).toBe(false);
  });
});
