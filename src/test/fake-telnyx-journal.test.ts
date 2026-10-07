import { describe, expect, it, vi } from "vitest";
import { sessionOwnership, type Ownership } from "@/server/telephony/ownership";
import { ProviderOutcomeUnknownError } from "@/server/telephony/provider-journal";
import { SessionLeaseLostError } from "@/server/telephony/service-errors";
import { createTelnyxClient, TelnyxCommandError } from "@/server/telephony/telnyx/client";
import { createFakeSupabase } from "./fake-supabase";
import { registerContractTwoRpcs } from "./fake-stability";
import { createFakeTelnyx } from "./fake-telnyx";

const CALL = "inbound/encoded+id%";
const PATH = `/calls/${encodeURIComponent(CALL)}/actions/hangup`;
const ORIGINAL = { callControlId: CALL, commandId: "original-hangup", clientState: "exact-state" };

function harness() {
  const now = Date.now();
  const { db, admin } = createFakeSupabase({ now: () => new Date(now) });
  registerContractTwoRpcs(db);
  db.seed("motorist_call_sessions", [{ id: "session", organization_id: "org", writer_contract: 2,
    state: "wrap_up", termination_requested_at: new Date(now).toISOString(),
    lease_token: "owner", lease_generation: 1, lease_until: new Date(now + 15_000).toISOString() }]);
  const owner: Ownership = { admin, sessionId: "session", organizationId: "org", token: "owner",
    generation: 1, contract: 2, acquiredAt: now, deadline: now + 24_000 };
  const fake = createFakeTelnyx();
  fake.physical.answered(CALL);
  const run = <T>(work: () => Promise<T>) => sessionOwnership.run(owner, work);
  const command = (id: string) => db.rows("motorist_provider_commands").find(row => row.command_id === id)!;
  const recovery = (slot = "recovery-1") => fake.client.request("POST", PATH, {
    journalCommandId: slot, commandId: ORIGINAL.commandId,
    body: command(ORIGINAL.commandId).request_payload as Record<string, unknown>, retryRateLimits: false,
  });
  return { db, owner, fake, run, command, recovery };
}

describe("fake hangup uses the real provider journal", () => {
  it("recovers a request that failed before reaching the provider under a new internal slot and the original wire identity", async () => {
    const h = harness();
    const ended = vi.spyOn(h.fake.physical, "ended");
    h.fake.failNext("hangup", new Error("socket never connected"));
    await h.run(async () => {
      await expect(h.fake.client.hangup(ORIGINAL)).rejects.toThrow("socket never connected");
      expect(h.command(ORIGINAL.commandId)).toMatchObject({ outcome: "unknown", path: PATH,
        request_payload: { client_state: "exact-state", command_id: ORIGINAL.commandId } });
      expect(await h.fake.client.retrieveCall(CALL)).toMatchObject({ known: true, alive: true,
        raw: { call_control_id: CALL, is_alive: true } });
      // Production dispatchJournaled refuses blind replay of the original row.
      await expect(h.fake.client.hangup(ORIGINAL)).rejects.toBeInstanceOf(ProviderOutcomeUnknownError);
      expect(h.fake.of("hangup")).toHaveLength(1);
      expect(await h.recovery()).toEqual({ data: { result: "ok" } });
      const original = h.command(ORIGINAL.commandId);
      const recovered = h.command("recovery-1");
      expect(recovered).toMatchObject({ outcome: "accepted", fingerprint: original.fingerprint,
        path: original.path, correlation_state: original.correlation_state, request_payload: original.request_payload });
      expect(original.outcome).toBe("unknown");
      expect(h.fake.of("request")[0].params).toMatchObject({ method: "POST", path: PATH,
        journalCommandId: "recovery-1", commandId: ORIGINAL.commandId, body: original.request_payload });
      expect(await h.recovery()).toEqual({ data: { result: "ok" } });
      expect(h.fake.of("hangup")).toHaveLength(2);
      expect(h.fake.of("request")).toHaveLength(1);
    });
    expect(ended).toHaveBeenCalledExactlyOnceWith(CALL);
    expect(h.fake.physical.legs.size).toBe(1);
  });

  it("models accepted hangup with lost acknowledgements, including a deduplicated recovery response lost again", async () => {
    const h = harness();
    const ended = vi.spyOn(h.fake.physical, "ended");
    h.fake.loseNextResponse("hangup");
    await h.run(async () => {
      await expect(h.fake.client.hangup(ORIGINAL)).rejects.toMatchObject({ code: "timeout" });
      expect(await h.fake.client.retrieveCall(CALL)).toMatchObject({ alive: false,
        raw: { call_control_id: CALL, is_alive: false } });
      h.fake.loseNextResponse("hangup");
      await expect(h.recovery()).rejects.toMatchObject({ code: "timeout" });
      expect(h.command("recovery-1").outcome).toBe("unknown");
      await expect(h.recovery()).rejects.toBeInstanceOf(ProviderOutcomeUnknownError);
      await expect(h.recovery("recovery-2")).resolves.toEqual({ data: { result: "ok" } });
    });
    expect(ended).toHaveBeenCalledExactlyOnceWith(CALL);
    expect(h.fake.of("hangup")).toHaveLength(3);
    expect(h.fake.of("request")).toHaveLength(2);
    expect(h.command("recovery-2").request_payload).toEqual(h.command(ORIGINAL.commandId).request_payload);
  });

  it.each([422, 429, 500])("records injected HTTP %i without physically ending the leg or automatically resending", async status => {
    const h = harness();
    h.fake.failNext("hangup", new Error("unacknowledged original"));
    await h.run(async () => {
      await expect(h.fake.client.hangup(ORIGINAL)).rejects.toThrow("unacknowledged original");
      h.fake.failAlways("hangup", new TelnyxCommandError({ status, code: "injected", detail: "provider response" }));
      await expect(h.recovery()).rejects.toMatchObject({ status });
      expect(h.command("recovery-1")).toMatchObject({ http_status: status,
        outcome: status === 422 ? "rejected" : status === 429 ? "rate_limited" : "unknown" });
      await expect(h.recovery()).rejects.toThrow();
    });
    expect(h.fake.of("request")).toHaveLength(1);
    expect(h.fake.physical.legs.get(CALL)?.ended).toBe(false);
  });

  it("refuses changed payload and a superseded owner before sending any provider request", async () => {
    const h = harness();
    await h.run(async () => {
      await h.fake.client.hangup(ORIGINAL);
      await expect(h.fake.client.request("POST", PATH, { journalCommandId: ORIGINAL.commandId,
        commandId: ORIGINAL.commandId, body: { client_state: "different" } })).rejects.toThrow("payload identity conflict");
      h.db.update("motorist_call_sessions", { lease_token: "new-owner", lease_generation: 2 }, row => row.id === "session");
      await expect(h.recovery()).rejects.toBeInstanceOf(SessionLeaseLostError);
    });
    expect(h.fake.of("request")).toHaveLength(0);
    expect(h.fake.of("hangup")).toHaveLength(1);
  });

  it("matches the real HTTP adapter's payload overwrite and keeps the recovery slot off the wire", async () => {
    const fake = createFakeTelnyx();
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({ data: { result: "ok" } }), { status: 200 }));
    const client = createTelnyxClient({ config: fake.client.config, liveGate: fake.client.liveGate, fetch });
    const options = { journalCommandId: "internal-slot", commandId: "wire-original",
      body: { command_id: "must-be-replaced", client_state: "exact-state" }, retryRateLimits: false };
    await expect(client.request("POST", PATH, options)).resolves.toEqual(await fake.client.request("POST", PATH, options));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(`${fake.client.config.apiBaseUrl}${PATH}`);
    expect(JSON.parse(String(init?.body))).toEqual(fake.of("request")[0].params.body);
    expect(JSON.parse(String(init?.body))).toEqual({ command_id: "wire-original", client_state: "exact-state" });
    expect(String(init?.body)).not.toContain("internal-slot");
  });
});

describe("fake retrieveCall evidence", () => {
  it("returns exact modelled physical state without inventing optional inbound identities", async () => {
    const fake = createFakeTelnyx();
    fake.physical.answered(CALL);
    expect((await fake.client.retrieveCall(CALL)).raw).toEqual({ call_control_id: CALL, is_alive: true });
    fake.physical.ended(CALL);
    expect((await fake.client.retrieveCall(CALL)).raw).toEqual({ call_control_id: CALL, is_alive: false });
    fake.setCallStatus(CALL, { alive: true, callLegId: "verified-leg", callSessionId: "verified-session" });
    expect(await fake.client.retrieveCall(CALL)).toMatchObject({ alive: true, callSessionId: "verified-session",
      raw: { call_control_id: CALL, is_alive: true, call_leg_id: "verified-leg", call_session_id: "verified-session" } });
    fake.setCallStatus(CALL, { known: false, alive: false });
    expect(await fake.client.retrieveCall(CALL)).toMatchObject({ known: false, alive: false, raw: null });
  });

  it("retains dial-returned identities and the legacy unmodelled default, and resets both", async () => {
    const fake = createFakeTelnyx();
    const dial = await fake.client.dial({ commandId: "dial", from: "+421900000001", to: "+421900000002" });
    expect((await fake.client.retrieveCall(dial.callControlId)).raw).toEqual({ call_control_id: dial.callControlId,
      is_alive: true, call_leg_id: dial.callLegId, call_session_id: dial.callSessionId });
    const legacy = { known: true, alive: true, callSessionId: null, raw: null };
    expect(await fake.client.retrieveCall("never-modelled")).toMatchObject(legacy);
    fake.reset();
    expect(await fake.client.retrieveCall(dial.callControlId)).toMatchObject(legacy);
  });
});
