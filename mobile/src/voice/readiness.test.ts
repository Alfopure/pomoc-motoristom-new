import { describe, expect, it } from "vitest";
import { phoneReadiness } from "./readiness";
import type { PhoneState } from "./phone";
import type { MobileVoiceReadiness } from "../../../src/lib/mobile-api";

const now = Date.parse("2026-10-15T13:00:00Z");
const configuration: MobileVoiceReadiness = { ok: true, apiVersion: 1, environment: "test", profileId: "operator", checkedAt: new Date(now).toISOString(), nativeCallingEnabled: true, backgroundIncomingEnabled: true };
const state: PhoneState = { nativeSyncPending: false, transferPending: null, holdPhase: "idle", supported: true, registration: "registered", takeoverRequired: false, call: null, termination: null, dialing: false, cancelingAttempt: false,
  audioActive: false, muted: false, speaker: false, error: null, microphonePermission: "granted", pushRegistered: true,
  lastHeartbeatAt: new Date(now).toISOString(), heartbeatError: null, diagnosticsError: null, checkingDiagnostics: false, retryTarget: null };
const inspect = (changes: Partial<PhoneState> = {}, options: Partial<Parameters<typeof phoneReadiness>[0]> = {}) => phoneReadiness({ state: { ...state, ...changes }, configuration, presence: "available", now, ...options });

describe("operator phone readiness", () => {
  it("shows confirmed hold separately from an active conversation", () => {
    expect(inspect({ call: { id: "call", sessionId: "session", state: "ACTIVE", number: null, outgoing: false, connected: true,
      media: { version: 8, state: "held", canHold: true, callControlId: "leg" } } }).title).toBe("Hovor je podržaný");
  });
  it.each(["requesting", "pending", "uncertain"] as const)("does not promise a settled call while hold is %s", holdPhase => {
    const result = inspect({ holdPhase, call: { id: "call", sessionId: "session", state: "ACTIVE", number: null, outgoing: false, connected: true } });
    expect(result.title).toBe("Overujem stav podržania…"); expect(result.tone).toBe("warning"); expect(result.canConnect).toBe(false);
  });
  it("keeps system reconciliation pending after the server has settled", () => {
    expect(inspect({ nativeSyncPending: true, call: { id: "call", sessionId: "session", state: "ACTIVE", number: null, outgoing: false, connected: true,
      media: { version: 8, state: "active", canHold: true, callControlId: "leg" } } }).title).toBe("Overujem stav podržania…");
  });
  it("does not infer native support from enabled backend flags", () => {
    const result = inspect({ supported: false });
    expect(result.canConnect).toBe(false); expect(result.tone).not.toBe("success");
    expect(result.message).toContain("natívnu");
  });
  it("distinguishes configured background registration from proven delivery", () => {
    const result = inspect();
    expect(result.checks.find(row => row.key === "background")?.value).toBe("Registrácia potvrdená");
    expect(result.message).toContain("skúšobným hovorom");
  });
  it.each([undefined, { ...configuration, nativeCallingEnabled: false, backgroundIncomingEnabled: false }])("does not promise calls with missing or disabled configuration", value => {
    expect(inspect({}, { configuration: value }).tone).not.toBe("success");
  });
  it("says calling is not activated without naming an environment the production app could show", () => {
    expect(inspect({}, { configuration: { ...configuration, nativeCallingEnabled: false, backgroundIncomingEnabled: false } }).message)
      .toBe("Hovory v aplikácii ešte nie sú aktivované.");
  });
  it("does not show a cached configuration as ready after its refresh failed", () => {
    expect(inspect({}, { configurationError: true }).tone).not.toBe("success");
  });
  it.each(["denied", "undetermined", "unknown"] as const)("keeps %s microphone permission distinct from granted", microphonePermission => {
    expect(inspect({ microphonePermission }).tone).not.toBe("success");
  });
  it("does not use an old or failed heartbeat as evidence of current readiness", () => {
    expect(inspect({ lastHeartbeatAt: new Date(now - 90_000).toISOString() }).tone).not.toBe("success");
    expect(inspect({ heartbeatError: "Network unavailable" }).tone).not.toBe("success");
  });
  it("separates an available SIP phone from background registration", () => {
    expect(inspect({ pushRegistered: false }).checks.find(row => row.key === "background")?.tone).not.toBe("success");
  });
  it("does not offer reconnect or takeover during a call, termination or outgoing operation", () => {
    for (const change of [{ call: { id: "call", sessionId: "session", state: "RECONNECTING", number: null, outgoing: false, connected: true } }, { termination: "session" }, { dialing: true }]) {
      expect(inspect({ registration: "error", ...change }).canConnect).toBe(false);
    }
  });
  it("offers ordinary reconnect for an uncertain request, while keeping takeover blocked", () => {
    const result = inspect({ registration: "error", retryTarget: { kind: "external", number: "+421900000002" }, takeoverRequired: true });
    expect(result.canConnect).toBe(true); expect(result.canTakeover).toBe(false);
    expect(result.message).toContain("druhom zariadení");
  });
  it("does not present a paused dispatcher as available for customer calls", () => {
    const result = inspect({}, { presence: "paused" });
    expect(result.tone).not.toBe("success"); expect(result.message).toContain("Dostupný");
  });
});
