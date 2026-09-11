import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { reconcileTermination } from "./termination";
import { SessionLeaseLostError } from "./service-errors";
import { TelnyxCommandError, type TelnyxClient } from "./telnyx/client";

function harness(failure?: Error) {
  const completed = new Set<string>();
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "motorist_provider_termination_legs_v2") return { data: [{ commandId: "dial-a", callControlId: "leg-a" }, { commandId: "dial-b", callControlId: "leg-b" }].filter(row => !completed.has(row.commandId)), error: null };
    if (name === "motorist_provider_termination_checkpoint_v2") {
      for (const id of args.p_completed_commands as string[]) completed.add(id);
      return { data: { pending: completed.size !== 2 }, error: null };
    }
    throw new Error(name);
  });
  const hangup = vi.fn(async ({ callControlId }: { callControlId: string }) => {
    if (callControlId === "leg-a" && failure) throw failure;
    return { status: "executed" };
  });
  return { completed, hangup, rpc, deps: { admin: { rpc } as unknown as SupabaseClient<Database>, organizationId: "org",
    telnyx: { hangup } as unknown as TelnyxClient, logger: vi.fn() } };
}

describe("durable termination cleanup", () => {
  it("continues another accepted leg when the first hangup has an unknown result", async () => {
    const h = harness(new Error("accepted hangup response lost"));
    expect(await reconcileTermination(h.deps, "session")).toBe(true);
    expect(h.hangup.mock.calls.map(([input]) => input.callControlId)).toEqual(["leg-a", "leg-b"]);
    expect([...h.completed]).toEqual(["dial-b"]);
    // A future pass retains only the unresolved obligation; the accepted B
    // result/checkpoint prevents another physical command for B.
    h.hangup.mockClear();
    expect(await reconcileTermination(h.deps, "session")).toBe(true);
    expect(h.hangup.mock.calls.map(([input]) => input.callControlId)).toEqual(["leg-a"]);
  });

  it("aborts later commands after lease loss", async () => {
    const h = harness(new SessionLeaseLostError());
    await expect(reconcileTermination(h.deps, "session")).rejects.toBeInstanceOf(SessionLeaseLostError);
    expect(h.hangup).toHaveBeenCalledTimes(1);
    expect(h.completed.size).toBe(0);
  });

  it("accepts explicit call-gone evidence but retains an unexplained HTTP 404", async () => {
    const gone = harness(new TelnyxCommandError({ code: "90018", status: 422 }));
    expect(await reconcileTermination(gone.deps, "session")).toBe(false);
    const missing = harness(new TelnyxCommandError({ code: "http_404", status: 404 }));
    expect(await reconcileTermination(missing.deps, "session")).toBe(true);
    expect([...missing.completed]).toEqual(["dial-b"]);
  });

  it("clears the retry obligation after all exact legs have confirmed cleanup", async () => {
    const h = harness();
    expect(await reconcileTermination(h.deps, "session")).toBe(false);
    expect(await reconcileTermination(h.deps, "session")).toBe(false);
    expect(h.hangup).toHaveBeenCalledTimes(2);
  });
});
