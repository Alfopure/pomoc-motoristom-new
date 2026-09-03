import { describe, expect, it } from "vitest";

import { CLIENT_STATE_MAX_BYTES, ClientStateError, decodeClientState, encodeClientState, type TelnyxClientState } from "./client-state";

const SID = "6f1c1c1e-1234-4abc-8def-0123456789ab";
const OPERATOR = "0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d";

describe("client-state", () => {
  it("round-trips every field and stays under the byte budget", () => {
    const state: TelnyxClientState = { sid: SID, role: "operator", operatorId: OPERATOR, step: 12, intent: "callback_prompt", autoAnswer: true };
    const encoded = encodeClientState(state);

    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(CLIENT_STATE_MAX_BYTES);
    expect(decodeClientState(encoded)).toEqual(state);
  });

  it("omits optional fields and false autoAnswer", () => {
    const encoded = encodeClientState({ sid: SID, role: "customer", autoAnswer: false });
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toEqual({ s: SID, r: "customer" });
    expect(decodeClientState(encoded)).toEqual({ sid: SID, role: "customer" });
  });

  it("accepts url-safe base64 as sent back by some proxies", () => {
    const encoded = encodeClientState({ sid: SID, role: "consult", intent: "consult" });
    const urlSafe = encoded.replace(/\+/g, "-").replace(/\//g, "_");
    expect(decodeClientState(urlSafe)).toEqual({ sid: SID, role: "consult", intent: "consult" });
  });

  it("rejects invalid states on encode", () => {
    expect(() => encodeClientState({ sid: "", role: "customer" })).toThrow(ClientStateError);
    expect(() => encodeClientState({ sid: SID, role: "boss" as TelnyxClientState["role"] })).toThrow(/role/);
    expect(() => encodeClientState({ sid: SID, role: "operator", step: -1 })).toThrow(/step/);
    expect(() => encodeClientState({ sid: SID, role: "operator", step: 1.5 })).toThrow(/step/);
    expect(() => encodeClientState({ sid: SID, role: "operator", intent: "has space" })).toThrow(/intent/);
    expect(() => encodeClientState({ sid: SID, role: "operator", intent: "x".repeat(40) })).toThrow(/intent/);
    expect(() => encodeClientState({ sid: "a".repeat(120), role: "operator" })).toThrow(/sid/);
  });

  it("returns null for foreign, malformed or oversized decode input", () => {
    expect(decodeClientState(undefined)).toBeNull();
    expect(decodeClientState(null)).toBeNull();
    expect(decodeClientState("")).toBeNull();
    expect(decodeClientState("not base64 json")).toBeNull();
    expect(decodeClientState(Buffer.from("[1,2]").toString("base64"))).toBeNull();
    expect(decodeClientState(Buffer.from('{"s":"x","r":"nope"}').toString("base64"))).toBeNull();
    expect(decodeClientState(Buffer.from('{"s":"x","r":"customer","a":"yes"}').toString("base64"))).toBeNull();
    expect(decodeClientState(Buffer.from('{"s":"x","r":"customer","p":"1"}').toString("base64"))).toBeNull();
    expect(decodeClientState("A".repeat(CLIENT_STATE_MAX_BYTES + 40))).toBeNull();
  });

  it("tolerates a legacy boolean autoAnswer on the wire", () => {
    expect(decodeClientState(Buffer.from(`{"s":"${SID}","r":"operator","a":true}`).toString("base64"))).toEqual({
      sid: SID,
      role: "operator",
      autoAnswer: true,
    });
  });
});
