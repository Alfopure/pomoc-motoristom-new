import { describe, expect, it, vi } from "vitest";
import { sessionOwnership, type Ownership } from "@/server/telephony/ownership";
import { createTelnyxClient } from "@/server/telephony/telnyx/client";
import { getTelnyxConfig } from "@/server/telephony/telnyx/env";
import { createFakeSupabase } from "./fake-supabase";
import { registerProviderJournalRpcs } from "./fake-stability";

function harness() {
  const now = Date.now();
  const { db, admin } = createFakeSupabase({ now: () => new Date(now) });
  registerProviderJournalRpcs(db);
  db.seed("motorist_call_sessions", [{ id: "session", state: "ringing", writer_contract: 2,
    lease_token: "token", lease_generation: 1, lease_until: new Date(now + 15_000).toISOString() }]);
  const owner: Ownership = { admin, sessionId: "session", organizationId: "org", token: "token",
    generation: 1, contract: 2, acquiredAt: now, deadline: now + 24_000 };
  let legs = 0;
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: {
    call_control_id: `leg-${++legs}`, call_leg_id: `provider-leg-${legs}`, call_session_id: "provider-session",
  } }), { status: 200 }));
  const client = createTelnyxClient({
    config: getTelnyxConfig({ TELNYX_API_KEY: "test", TELNYX_CALL_CONTROL_APP_ID: "app", TELNYX_API_BASE_URL: "https://telnyx.test/v2" }),
    liveGate: { callsEnabled: true, smsEnabled: false }, fetch,
  });
  return { db, owner, client, fetch };
}

describe("batch journal identity through the real provider adapter", () => {
  it("rolls back the whole batch before HTTP when two destinations share one identity", async () => {
    const h = harness();
    await sessionOwnership.run(h.owner, async () => {
      await expect(h.client.dialMany([
        { commandId: "other-operator", to: "sip:other@example.invalid", from: "+421900000001" },
        { commandId: "same-operator", to: "sip:operator@example.invalid", from: "+421900000001" },
        { commandId: "same-operator", to: "+421900000002", from: "+421900000001" },
      ])).rejects.toThrow("provider command payload identity conflict");
    });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.db.rows("motorist_provider_commands")).toEqual([]);
  });

  it("replays accepted distinct members without new provider calls", async () => {
    const h = harness();
    const dials = [
      { commandId: "operator-1", to: "sip:first@example.invalid", from: "+421900000001" },
      { commandId: "operator-2", to: "sip:second@example.invalid", from: "+421900000001" },
    ];
    await sessionOwnership.run(h.owner, async () => {
      const original = await h.client.dialMany(dials);
      expect(original.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(await h.client.dialMany(dials)).toEqual(original);
      await expect(h.client.dialMany([{ ...dials[0], to: "+421900000002" }]))
        .rejects.toThrow("provider command payload identity conflict");
    });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.db.rows("motorist_provider_commands")).toHaveLength(2);
  });
});
