import { describe, expect, it } from "vitest";
import { isAppRefreshBlocked } from "./app-refresh-policy";
import { buildPhoneBarModel, EMPTY_ACTIVE_CALLS } from "@/lib/telephony/active-calls-model";
import { WEBPHONE_INITIAL_STATE, webphoneRegistrationView } from "@/lib/telephony/webphone-model";

type RefreshState = Parameters<typeof isAppRefreshBlocked>[0];

function idlePhone(): RefreshState {
  return {
    phone: {
      status: "registered",
      registration: webphoneRegistrationView(WEBPHONE_INITIAL_STATE),
      sipUsername: null,
      deviceSessionId: null,
      call: null,
      message: null,
    },
    phoneBar: buildPhoneBarModel(EMPTY_ACTIVE_CALLS),
    busyAction: null,
    presenceBusy: false,
    outboundPending: false,
  };
}

describe("application reload phone protection", () => {
  it.each(["idle", "registered", "failed", "superseded", "not_configured"] as const)("allows manual reload when phone is %s and has no work", (status) => {
    const state = idlePhone();
    state.phone.status = status;
    expect(isAppRefreshBlocked(state)).toBe(false);
  });

  it.each(["requesting_token", "connecting", "reconnecting"] as const)("protects %s", (status) => {
    const state = idlePhone();
    state.phone.status = status;
    expect(isAppRefreshBlocked(state)).toBe(true);
  });

  it("protects a new browser invite before the server poll knows about it", () => {
    const state = idlePhone();
    state.phone.call = {
      id: "invite", state: "ringing", direction: "inbound", number: "", callerName: null,
      telnyxCallControlId: null, sessionId: null, muted: false, ringing: true, active: false,
    };
    expect(isAppRefreshBlocked(state)).toBe(true);
    state.phone.call = null;
    expect(isAppRefreshBlocked(state)).toBe(false);
  });

  it("protects pending supervision even before its media connection exists", () => {
    const state = idlePhone();
    state.phoneBar.supervising = { sessionId: "observed-call", mode: "monitor", pending: true };
    expect(isAppRefreshBlocked(state)).toBe(true);
  });

  it("protects phone operations and presence changes until they finish", () => {
    const state = idlePhone();
    state.busyAction = "dial";
    expect(isAppRefreshBlocked(state)).toBe(true);
    state.busyAction = null;
    state.presenceBusy = true;
    expect(isAppRefreshBlocked(state)).toBe(true);
    state.presenceBusy = false;
    expect(isAppRefreshBlocked(state)).toBe(false);
  });

  it("protects an outbound request and the gap before its invite arrives", () => {
    const state = idlePhone();
    state.outboundPending = true;
    expect(isAppRefreshBlocked(state)).toBe(true);
    state.outboundPending = false;
    expect(isAppRefreshBlocked(state)).toBe(false);
  });
});
