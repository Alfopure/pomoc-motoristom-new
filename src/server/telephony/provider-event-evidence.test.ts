import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { contactOperationIntent } from "./contact-proof";
import { sessionOwnership, type Ownership } from "./ownership";
import { commandEvidenceCandidate, reconcileProviderEvent, type PendingProviderCommand } from "./provider-event-evidence";
import { ProviderOutcomeUnknownError } from "./provider-journal";
import { parseTelnyxEnvelope } from "./state/events";
import { encodeClientState } from "./telnyx/client-state";
import { createTelnyxClient } from "./telnyx/client";
import { getTelnyxConfig } from "./telnyx/env";

const dispatched = "2026-09-29T12:00:00.123456Z";
const state = encodeClientState({ sid: "session", role: "customer", intent: contactOperationIntent("bridge-command") });
const command = (patch: Partial<PendingProviderCommand> = {}): PendingProviderCommand => ({ commandId: "bridge-command", fingerprint: "immutable", path: "/calls/source/actions/bridge", payload: { call_control_id: "target", client_state: state }, dispatchGeneration: 1, dispatchToken: "old-token", firstDispatchedAt: dispatched, correlationState: state, ...patch });
const event = (type = "call.bridged", payload: Record<string, unknown> = {}, occurredAt = "2026-09-29T12:00:01Z") => parseTelnyxEnvelope({ data: { id: "event", event_type: type, occurred_at: occurredAt, payload: { call_control_id: "source", client_state: state, ...payload } } })!;

function harness(commands: PendingProviderCommand[] = [command()]) {
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>): Promise<{ data: unknown; error: null }> => {
    if (name === "motorist_provider_pending_commands_v2") return { data: commands, error: null };
    if (name === "motorist_provider_command_result_v2" || name === "motorist_session_lease_renew_v2") return { data: true, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  });
  const admin = { rpc } as unknown as SupabaseClient<Database>;
  const owner: Ownership = { admin, sessionId: "session", organizationId: "org", token: "new-token", generation: 9, contract: 2, deadline: Date.now() + 24_000 };
  return { rpc, admin, owner };
}

describe("exact provider event evidence", () => {
  it("binds bridge to its source, immutable target and unique command intent", () => {
    expect(commandEvidenceCandidate(command(), "session", event())).toBe(true);
    for (const bad of [event("call.bridged", { call_control_id: "target" }), event("call.bridged", { client_state: encodeClientState({ sid: "session", role: "customer", intent: "ring" }) }), event("call.bridged", { client_state: null })]) {
      expect(commandEvidenceCandidate(command(), "session", bad)).toBe(false);
    }
    expect(commandEvidenceCandidate(command({ payload: { call_control_id: "source", client_state: state } }), "session", event())).toBe(false);
    expect(commandEvidenceCandidate(command({ commandId: "other" }), "session", event())).toBe(false);
  });

  it("rejects old or missing event timestamps including sub-millisecond ordering", () => {
    for (const date of ["2026-09-29T11:59:59Z", "2026-09-29T12:00:00.123455Z", "invalid"]) {
      expect(commandEvidenceCandidate(command(), "session", { ...event(), occurredAt: date })).toBe(false);
    }
    expect(commandEvidenceCandidate(command(), "session", { ...event(), occurredAt: null })).toBe(false);
    expect(commandEvidenceCandidate(command(), "session", event("call.bridged", {}, dispatched))).toBe(true);
  });

  it.each([["answer", "call.answered"], ["hangup", "call.hangup"]])("adopts %s only on the exact leg", (action, type) => {
    const c = command({ path: `/calls/source/actions/${action}`, payload: {} });
    expect(commandEvidenceCandidate(c, "session", event(type))).toBe(true);
    expect(commandEvidenceCandidate(c, "session", event(type, { call_control_id: "wrong-leg" }))).toBe(false);
  });

  it.each([["join", "conference.participant.joined"], ["leave", "conference.participant.left"]])("adopts conference %s only with both exact IDs", (action, type) => {
    const c = command({ path: `/conferences/conf/actions/${action}`, payload: { call_control_id: "source" } });
    expect(commandEvidenceCandidate(c, "session", event(type, { conference_id: "conf" }))).toBe(true);
    expect(commandEvidenceCandidate(c, "session", event(type, { conference_id: "other" }))).toBe(false);
    expect(commandEvidenceCandidate(c, "session", event(type, { conference_id: "conf", call_control_id: "other" }))).toBe(false);
  });

  it("preserves the original dispatch tuple when a newer owner records evidence", async () => {
    const h = harness();
    expect(await sessionOwnership.run(h.owner, () => reconcileProviderEvent(h.admin, "session", event()))).toBe(1);
    expect(h.rpc).toHaveBeenLastCalledWith("motorist_provider_command_result_v2", expect.objectContaining({ p_generation: 1, p_token: "old-token", p_fingerprint: "immutable", p_command_id: "bridge-command" }));
  });

  it("does not adopt ambiguous repeated operations or recording completion", async () => {
    const c = command({ path: "/calls/source/actions/answer", payload: {} });
    const h = harness([c, { ...c, commandId: "second" }]);
    expect(await sessionOwnership.run(h.owner, () => reconcileProviderEvent(h.admin, "session", event("call.answered")))).toBe(0);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(await sessionOwnership.run(h.owner, () => reconcileProviderEvent(h.admin, "session", event("call.recording.saved")))).toBe(0);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(await reconcileProviderEvent(h.admin, "session", event())).toBe(0);
  });

  it("verifies conference creator, exact ID and immutable name with one read", async () => {
    const h = harness([command({ path: "/conferences", payload: { call_control_id: "source", name: "session-command" } })]);
    const request = vi.fn().mockResolvedValue({ data: { id: "conf", name: "wrong" } });
    const e = event("conference.created", { conference_id: "conf" });
    expect(await sessionOwnership.run(h.owner, () => reconcileProviderEvent(h.admin, "session", e, { request }))).toBe(0);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    request.mockResolvedValue({ data: { id: "conf", name: "session-command" } });
    expect(await sessionOwnership.run(h.owner, () => reconcileProviderEvent(h.admin, "session", e, { request }))).toBe(1);
    expect(request).toHaveBeenLastCalledWith("GET", "/conferences/conf");
    expect(h.rpc).toHaveBeenLastCalledWith("motorist_provider_command_result_v2", expect.objectContaining({ p_result: { data: { id: "conf", name: "session-command" } } }));
  });

  it("recovers a bridge after a lost HTTP response without issuing a second POST", async () => {
    const h = harness();
    let pending: PendingProviderCommand | null = null;
    let accepted: unknown;
    h.rpc.mockImplementation(async (name, args) => {
      if (name === "motorist_session_lease_renew_v2") return { data: true, error: null };
      if (name === "motorist_provider_command_prepare_v2") {
        if (pending) return { data: { dispatch: false, outcome: accepted ? "accepted" : "unknown", result: accepted }, error: null };
        pending = command({ fingerprint: String(args.p_fingerprint), payload: args.p_payload as Record<string, unknown>, dispatchGeneration: h.owner.generation, dispatchToken: h.owner.token });
        return { data: { dispatch: true }, error: null };
      }
      if (name === "motorist_provider_pending_commands_v2") return { data: accepted ? [] : [pending!], error: null };
      if (name === "motorist_provider_command_result_v2") { accepted = args.p_result; return { data: true, error: null }; }
      throw new Error(name);
    });
    const fetch = vi.fn().mockRejectedValue(new Error("provider accepted but response lost"));
    const client = createTelnyxClient({ config: getTelnyxConfig({ TELNYX_API_KEY: "test", TELNYX_CALL_CONTROL_APP_ID: "app", TELNYX_API_BASE_URL: "https://telnyx.test/v2" }), liveGate: { callsEnabled: true, smsEnabled: false }, fetch });
    const bridge = () => client.bridge({ callControlId: "source", targetCallControlId: "target", commandId: "bridge-command", clientState: state });
    await expect(sessionOwnership.run(h.owner, bridge)).rejects.toMatchObject({ code: "network" });
    await expect(sessionOwnership.run(h.owner, bridge)).rejects.toBeInstanceOf(ProviderOutcomeUnknownError);
    expect(await sessionOwnership.run(h.owner, () => reconcileProviderEvent(h.admin, "session", event(), client))).toBe(1);
    await sessionOwnership.run(h.owner, bridge);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
