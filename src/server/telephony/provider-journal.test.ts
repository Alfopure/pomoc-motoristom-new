import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { sessionOwnership, type Ownership } from "./ownership";
import { createTelnyxClient } from "./telnyx/client";
import { getTelnyxConfig } from "./telnyx/env";
import { ProviderOutcomeUnknownError } from "./provider-journal";

function harness() {
  let generation = 1;
  let failEvidence = false;
  const journal = new Map<string, { fingerprint: string; generation: number; outcome: string; result?: unknown }>();
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "motorist_session_lease_renew_v2") return { data: args.p_generation === generation, error: null };
    const id = String(args.p_command_id);
    if (name === "motorist_provider_command_prepare_v2") {
      const prior = journal.get(id);
      if (prior) {
        if (prior.fingerprint !== args.p_fingerprint) return { data: null, error: { message: "payload identity conflict", code: "PT409" } };
        return { data: { ...prior, dispatch: false }, error: null };
      }
      journal.set(id, { fingerprint: String(args.p_fingerprint), generation, outcome: "unknown" });
      return { data: { dispatch: true }, error: null };
    }
    if (name === "motorist_provider_command_result_v2") {
      if (failEvidence) return { data: null, error: { message: "database unavailable" } };
      const prior = journal.get(id)!;
      expect(args.p_generation).toBe(prior.generation);
      prior.outcome = Number(args.p_status) < 300 ? "accepted" : "unknown";
      prior.result = args.p_result;
      return { data: true, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  const admin = { rpc } as unknown as SupabaseClient<Database>;
  const owner = (): Ownership => ({ admin, sessionId: "session", organizationId: "org", token: `token-${generation}`, generation, contract: 2, deadline: Date.now() + 24_000 });
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { call_control_id: "exact-leg", call_leg_id: "leg", call_session_id: "provider-session", is_alive: true } }), { status: 200 }));
  const client = createTelnyxClient({ config: getTelnyxConfig({ TELNYX_API_KEY: "test", TELNYX_CALL_CONTROL_APP_ID: "app", TELNYX_API_BASE_URL: "https://telnyx.test/v2" }), liveGate: { callsEnabled: true, smsEnabled: false }, fetch });
  const dial = () => client.dial({ commandId: "dial", to: "+421900000001", from: "+421900000002" });
  return { client, dial, owner, fetch, journal, rpc, takeover: () => { generation++; }, failEvidence: () => { failEvidence = true; } };
}

describe("provider HTTP journal recovery", () => {
  it("adopts provider acceptance when the later effects checkpoint failed", async () => {
    const h = harness();
    await expect(sessionOwnership.run(h.owner(), async () => {
      expect((await h.dial()).callControlId).toBe("exact-leg");
      throw new Error("effects checkpoint lost");
    })).rejects.toThrow("effects checkpoint lost");
    h.takeover();
    const adopted = await sessionOwnership.run(h.owner(), h.dial);
    expect(adopted.callControlId).toBe("exact-leg");
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("never redials when provider acceptance could not be stored", async () => {
    const h = harness();
    h.failEvidence();
    await expect(sessionOwnership.run(h.owner(), h.dial)).rejects.toThrow("database unavailable");
    h.takeover();
    await expect(sessionOwnership.run(h.owner(), h.dial)).rejects.toBeInstanceOf(ProviderOutcomeUnknownError);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([61_000, 301_000])("does not blindly dial an unknown outcome after %d ms", async age => {
    const h = harness();
    h.fetch.mockRejectedValueOnce(new Error("response lost"));
    await expect(sessionOwnership.run(h.owner(), h.dial)).rejects.toMatchObject({ code: "network" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + age);
    try {
      h.takeover();
      await expect(sessionOwnership.run(h.owner(), h.dial)).rejects.toBeInstanceOf(ProviderOutcomeUnknownError);
      expect(h.fetch).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });

  it("retains an in-flight result after takeover but fences the old owner's next command", async () => {
    const h = harness();
    const original = h.owner();
    h.fetch.mockImplementationOnce(async () => {
      h.takeover();
      return new Response(JSON.stringify({ data: { call_control_id: "late-leg" } }), { status: 200 });
    });
    await sessionOwnership.run(original, async () => {
      expect((await h.dial()).callControlId).toBe("late-leg");
      await expect(h.client.hangup({ callControlId: "other-leg", commandId: "old-next" })).rejects.toMatchObject({ name: "SessionLeaseLostError" });
    });
    expect(h.journal.get("dial")).toMatchObject({ generation: 1, outcome: "accepted" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("journals conference hold without adding an undocumented provider command_id", async () => {
    const h = harness();
    await sessionOwnership.run(h.owner(), () => h.client.conferenceAction("conference", "hold", { commandId: "hold", call_control_ids: ["leg"] }));
    h.takeover();
    await sessionOwnership.run(h.owner(), () => h.client.conferenceAction("conference", "hold", { commandId: "hold", call_control_ids: ["leg"] }));
    expect(h.journal.get("hold")).toMatchObject({ outcome: "accepted" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ call_control_ids: ["leg"] }) }));
  });

  it("rejects a stable command ID reused with a different destination", async () => {
    const h = harness();
    await sessionOwnership.run(h.owner(), h.dial);
    h.takeover();
    await expect(sessionOwnership.run(h.owner(), () => h.client.dial({ commandId: "dial", to: "+421900000099", from: "+421900000002" }))).rejects.toThrow("payload identity conflict");
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});
