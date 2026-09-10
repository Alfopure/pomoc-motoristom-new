import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { completeTaskSourceIfSupported } from "./task-source-completion";

describe("durable task source completion boundary", () => {
  it("does not enable the legacy fallback when the installed function rejects proof", async () => {
    const fake = createFakeSupabase();
    fake.db.registerRpc("motorist_complete_task_source_v1", () => ({ completed: false }));
    await expect(completeTaskSourceIfSupported(fake.admin, "org", "sms", "source", "actor")).resolves.toBe(true);
    expect(fake.db.log.find(entry => entry.kind === "rpc")?.payload).toEqual({ p_organization_id: "org", p_source_type: "sms", p_source_id: "source", p_actor_id: "actor" });
  });
  it("allows the old schema only for an absent RPC, and propagates transient or permission failures", async () => {
    const fake = createFakeSupabase();
    await expect(completeTaskSourceIfSupported(fake.admin, "org", "location", "submission")).resolves.toBe(false);
    for (const code of ["42501", "08006", "XX000", "42883", "PGRST202"]) {
      fake.db.failNext("motorist_complete_task_source_v1", "rpc", { code, message: "internal", details: null, hint: null });
      await expect(completeTaskSourceIfSupported(fake.admin, "org", "location", "submission")).rejects.toThrow("Task source completion failed.");
    }
  });
});
