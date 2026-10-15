import { describe, expect, it, vi } from "vitest";
import { createVoiceApi } from "./api";
import type { MobileTransport } from "../lib/api";

const sessionId = "00000000-0000-4000-8000-000000000002";
const lease = "00000000-0000-4000-8000-000000000001";
const config = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "fixture" };
const scope = { ok: true, apiVersion: 1, environment: "test", profileId: "operator" };
const status = { ...scope, sessionId, state: "talking", connected: true, ended: false, terminationPending: false,
  media: { version: 8, state: "active", canHold: true, callControlId: "native-operator-leg" } };
const command = { requestId: lease, callControlId: "native-operator-leg", held: true, expectedVersion: 8 };
function api(body: unknown) {
  const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json(body));
  return { client: createVoiceApi(config, "operator", async () => "token", transport), transport };
}

describe("authoritative mobile hold transport", () => {
  it.each([
    undefined, null, [], {},
    { ...status.media, version: -1 }, { ...status.media, version: 1.5 }, { ...status.media, version: "8" },
    { ...status.media, version: Number.MAX_SAFE_INTEGER + 1 },
    { ...status.media, state: ["held"] }, { ...status.media, state: "optimistic" },
    { ...status.media, canHold: "true" }, { ...status.media, callControlId: "" },
    { ...status.media, callControlId: null }, { ...status.media, state: "pending" },
    { ...status.media, state: "unavailable" },
  ])("rejects untrusted or contradictory media proof %#", async media => {
    await expect(api({ ...status, media }).client.status(lease, sessionId)).rejects.toMatchObject({ status: 502 });
  });
  it.each([
    { connected: false }, { ended: true }, { terminationPending: true },
  ])("rejects a hold capability for a call that cannot be controlled %#", async change => {
    await expect(api({ ...status, ...change }).client.status(lease, sessionId)).rejects.toMatchObject({ status: 502 });
  });
  it("accepts an established held conversation separately from microphone mute", async () => {
    const held = { ...status, state: "held", media: { ...status.media, state: "held" } };
    expect(await api(held).client.status(lease, sessionId)).toMatchObject({ connected: true, media: { state: "held", version: 8 } });
  });
  it("accepts pending media without granting another hold command", async () => {
    expect(await api({ ...status, media: { ...status.media, state: "pending", canHold: false } }).client.status(lease, sessionId))
      .toMatchObject({ media: { state: "pending", canHold: false } });
  });
  it.each(["hold", "holdStatus"] as const)("sends the exact immutable %s identity with current authentication", async method => {
    const f = api({ ...status, operation: { requestId: lease, held: true, outcome: "pending" } });
    await f.client[method](lease, sessionId, command);
    expect(f.transport).toHaveBeenCalledExactlyOnceWith(config.apiOrigin + "/api/mobile/v1/voice/calls/" + sessionId + (method === "hold" ? "/hold" : "/hold/status"),
      expect.objectContaining({ method: "POST", credentials: "omit", body: JSON.stringify({ deviceSessionId: lease, ...command }),
        headers: expect.objectContaining({ Authorization: "Bearer token", "X-PM-App-Environment": "test" }) }));
  });
  it("canonicalizes CallKit's uppercase action UUID for the server receipt and every retry", async () => {
    const requestId = "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF";
    const f = api({ ...status, operation: { requestId: requestId.toLowerCase(), held: true, outcome: "accepted" } });
    await expect(f.client.hold(lease, sessionId, { ...command, requestId })).resolves.toMatchObject({ operation: { outcome: "accepted" } });
    expect(JSON.parse(String(f.transport.mock.calls[0][1].body)).requestId).toBe(requestId.toLowerCase());
  });
  it.each([
    undefined, null, [], {}, { requestId: sessionId, held: true, outcome: "accepted" },
    { requestId: lease, held: false, outcome: "accepted" }, { requestId: lease, held: "true", outcome: "accepted" },
    { requestId: lease, held: true, outcome: ["accepted"] }, { requestId: lease, held: true, outcome: "done" },
  ])("rejects a missing or mismatched operation receipt %#", async operation => {
    await expect(api({ ...status, operation }).client.hold(lease, sessionId, command)).rejects.toMatchObject({ status: 502 });
  });
  it("keeps historical acceptance distinct from the current media state", async () => {
    const result = await api({ ...status, media: { ...status.media, version: 12 }, operation: { requestId: lease, held: true, outcome: "accepted" } })
      .client.holdStatus(lease, sessionId, command);
    expect(result).toMatchObject({ media: { state: "active", version: 12 }, operation: { held: true, outcome: "accepted" } });
  });
  it.each([{ state: "held" }, { media: { ...status.media, state: "held" } }])("rejects disagreement between session and settled media %#", async change => {
    await expect(api({ ...status, ...change }).client.status(lease, sessionId)).rejects.toMatchObject({ status: 502 });
  });
  it.each([{ requestId: "not-a-uuid" }, { expectedVersion: -1 }, { expectedVersion: 2.5 }, { held: "true" }, { callControlId: "" }, { callControlId: "x".repeat(513) }])("does not send malformed immutable command input %#", async change => {
    const f = api({ ...status, operation: { requestId: lease, held: true, outcome: "accepted" } });
    await expect(f.client.hold(lease, sessionId, { ...command, ...change } as typeof command)).rejects.toMatchObject({ status: 502 });
    expect(f.transport).not.toHaveBeenCalled();
  });
});
