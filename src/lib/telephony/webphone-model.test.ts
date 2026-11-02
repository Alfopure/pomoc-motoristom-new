import { describe, expect, it } from "vitest";

import type { Call, TelnyxRTC } from "@telnyx/webrtc";

import type { WebphoneSdkCall, WebphoneSdkClient } from "./telnyx-webphone";
import {
  EXPECTED_LEG_TTL_MS,
  EXPECTED_REQUEST_TTL_MS,
  heartbeatRegistrationState,
  inviteRequestId,
  matchAutoAnswer,
  matchExpectedLeg,
  matchExpectedRequest,
  rememberExpectedRequest,
  inviteHasAutoAnswerHeader,
  inviteIsColleagueCall,
  reduceWebphone,
  rememberExpectedLeg,
  tokenRefreshDelayMs,
  TOKEN_REFRESH_MAX_MS,
  TOKEN_REFRESH_MIN_MS,
  webphoneRegistrationView,
  webphoneRetryDelayMs,
  WEBPHONE_INITIAL_STATE,
  WEBPHONE_RECONNECT_MAX_MS,
  type WebphoneCredentials,
  type WebphoneEvent,
  type WebphoneState,
} from "./webphone-model";

const NOW = Date.parse("2026-09-03T08:00:00.000Z");

function credentials(overrides: Partial<WebphoneCredentials> = {}): WebphoneCredentials {
  return {
    token: "jwt-token",
    expiresAt: new Date(NOW + 24 * 60 * 60 * 1_000).toISOString(),
    deviceSessionId: "device-1",
    sipUsername: "gencred123",
    ...overrides,
  };
}

function run(state: WebphoneState, events: WebphoneEvent[], now = NOW) {
  let current = state;
  let effects: ReturnType<typeof reduceWebphone>["effects"] = [];
  for (const event of events) {
    const result = reduceWebphone(current, event, { now, random: () => 0.5 });
    current = result.state;
    effects = result.effects;
  }
  return { state: current, effects };
}

describe("token refresh scheduling", () => {
  it("refreshes at 50 % of the remaining lifetime", () => {
    expect(tokenRefreshDelayMs({ expiresAt: new Date(NOW + 2 * 60 * 60 * 1_000).toISOString(), now: NOW })).toBe(60 * 60 * 1_000);
  });

  it("caps the wait so a 24 h token is still re-minted the same shift", () => {
    expect(tokenRefreshDelayMs({ expiresAt: new Date(NOW + 24 * 60 * 60 * 1_000).toISOString(), now: NOW })).toBe(
      TOKEN_REFRESH_MAX_MS,
    );
  });

  it("keeps a floor so a short token cannot become a mint loop", () => {
    expect(tokenRefreshDelayMs({ expiresAt: new Date(NOW + 90_000).toISOString(), now: NOW })).toBe(TOKEN_REFRESH_MIN_MS);
  });

  it("keeps a floor for an expired or unparsable expiry so it cannot become a mint loop", () => {
    expect(tokenRefreshDelayMs({ expiresAt: new Date(NOW - 1_000).toISOString(), now: NOW })).toBe(TOKEN_REFRESH_MIN_MS);
    expect(tokenRefreshDelayMs({ expiresAt: "nonsense", now: NOW })).toBe(TOKEN_REFRESH_MIN_MS);
  });
});

describe("connect lifecycle", () => {
  it("mints a token on start and connects with it", () => {
    const started = run(WEBPHONE_INITIAL_STATE, [{ type: "start" }]);
    expect(started.state.status).toBe("requesting_token");
    expect(started.effects).toContainEqual({ kind: "mint_token" });

    const connected = reduceWebphone(started.state, { type: "token_issued", credentials: credentials() }, { now: NOW });
    expect(connected.state.status).toBe("connecting");
    expect(connected.effects[0]).toEqual({ kind: "connect", credentials: credentials() });
    expect(connected.effects[1]).toEqual({ kind: "refresh_after", delayMs: TOKEN_REFRESH_MAX_MS });

    const ready = reduceWebphone(connected.state, { type: "client_ready" }, { now: NOW });
    expect(ready.state.status).toBe("registered");
    expect(ready.state.attempts).toBe(0);
  });

  it("keeps the registered pill steady while the token rotates", () => {
    const { state } = run(WEBPHONE_INITIAL_STATE, [
      { type: "start" },
      { type: "token_issued", credentials: credentials() },
      { type: "client_ready" },
      { type: "token_expiring" },
      { type: "token_issued", credentials: credentials({ token: "jwt-2", deviceSessionId: "device-2" }) },
    ]);
    expect(state.status).toBe("registered");
    expect(state.credentials?.deviceSessionId).toBe("device-2");
  });

  it("preserves credentials and leaves transient socket recovery to the SDK", () => {
    const registered = run(WEBPHONE_INITIAL_STATE, [
      { type: "start" },
      { type: "token_issued", credentials: credentials() },
      { type: "client_ready" },
    ]).state;

    const first = reduceWebphone(registered, { type: "socket_closed" }, { now: NOW, random: () => 0.5 });
    expect(first.state.status).toBe("reconnecting");
    expect(first.state.credentials).toEqual(registered.credentials);
    expect(first.effects).toEqual([{ kind: "await_recovery" }]);

    const second = reduceWebphone(first.state, { type: "socket_closed" }, { now: NOW, random: () => 0.5 });
    expect(second.effects).toEqual([{ kind: "await_recovery" }]);
    expect(webphoneRetryDelayMs(20, () => 0.5)).toBeLessThanOrEqual(WEBPHONE_RECONNECT_MAX_MS);
  });

  it("makes exhausted recovery terminal until an explicit start", () => {
    const { state, effects } = run(WEBPHONE_INITIAL_STATE, [{ type: "start" }, { type: "token_issued", credentials: credentials() },
      { type: "client_ready" }, { type: "socket_closed" }, { type: "recovery_failed" }]);
    expect(state.status).toBe("failed");
    expect(effects).toContainEqual({ kind: "disconnect" });
    expect(reduceWebphone(state, { type: "client_ready" }, { now: NOW }).state.status).toBe("failed");
    expect(reduceWebphone(state, { type: "start" }, { now: NOW }).state.status).toBe("requesting_token");
  });

  it("drops the token on an auth failure so the retry mints a new one", () => {
    const registered = run(WEBPHONE_INITIAL_STATE, [
      { type: "start" },
      { type: "token_issued", credentials: credentials() },
      { type: "client_ready" },
    ]).state;
    const failed = reduceWebphone(registered, { type: "client_error", message: "Unauthorized", authFailure: true }, { now: NOW });
    expect(failed.state.status).toBe("reconnecting");
    expect(failed.state.credentials).toBeNull();
    expect(failed.effects).toContainEqual({ kind: "disconnect" });
  });
});

describe("terminal states", () => {
  it("stops for good when the deployment has no telephony configuration", () => {
    const { state, effects } = run(WEBPHONE_INITIAL_STATE, [
      { type: "start" },
      { type: "token_rejected", status: 503, message: "Telefónia nie je nakonfigurovaná." },
    ]);
    expect(state.status).toBe("not_configured");
    expect(effects).toContainEqual({ kind: "disconnect" });
    // A later socket event must not resurrect the phone.
    expect(reduceWebphone(state, { type: "socket_closed" }, { now: NOW }).state.status).toBe("not_configured");
  });

  it("disconnects the tab when the heartbeat reports another window took over", () => {
    const registered = run(WEBPHONE_INITIAL_STATE, [
      { type: "start" },
      { type: "token_issued", credentials: credentials() },
      { type: "client_ready" },
    ]).state;
    const superseded = reduceWebphone(registered, { type: "superseded" }, { now: NOW });
    expect(superseded.state.status).toBe("superseded");
    expect(superseded.state.credentials).toBeNull();
    expect(superseded.effects).toContainEqual({ kind: "disconnect" });
    expect(webphoneRegistrationView(superseded.state).tone).toBe("error");
  });

  it("shows a second device as another phone owner and waits for explicit takeover", () => {
    const result = run(WEBPHONE_INITIAL_STATE, [{ type: "start" }, { type: "token_rejected", status: 409 }]);
    expect(result.state.status).toBe("superseded");
    expect(webphoneRegistrationView(result.state).label).toBe("Iné okno");
    expect(reduceWebphone(result.state, { type: "client_ready" }, { now: NOW }).state.status).toBe("superseded");
  });

  it("restarts from a terminal state only on an explicit start", () => {
    const dead = run(WEBPHONE_INITIAL_STATE, [{ type: "start" }, { type: "token_rejected", status: 403 }]).state;
    expect(dead.status).toBe("failed");
    expect(reduceWebphone(dead, { type: "start" }, { now: NOW }).state.status).toBe("requesting_token");
  });
});

describe("heartbeat registration state", () => {
  it("maps the browser status to the device row values", () => {
    expect(heartbeatRegistrationState("registered")).toBe("registered");
    expect(heartbeatRegistrationState("connecting")).toBe("registering");
    expect(heartbeatRegistrationState("reconnecting")).toBe("registering");
    expect(heartbeatRegistrationState("failed")).toBe("error");
    expect(heartbeatRegistrationState("superseded")).toBe("unregistered");
  });
});

describe("auto-answer correlation", () => {
  it("matches the invite by call control id", () => {
    const expected = rememberExpectedLeg([], { callControlId: "cc-1", sessionId: "sess-1", at: NOW }, NOW);
    expect(matchExpectedLeg(expected, { telnyxCallControlId: "cc-1" }, NOW)?.sessionId).toBe("sess-1");
    expect(matchExpectedLeg(expected, { telnyxCallControlId: "cc-2" }, NOW)).toBeNull();
    expect(matchExpectedLeg(expected, {}, NOW)).toBeNull();
  });

  it("forgets a dial that never produced an invite", () => {
    const expected = rememberExpectedLeg([], { callControlId: "cc-1", sessionId: "sess-1", at: NOW }, NOW);
    expect(matchExpectedLeg(expected, { telnyxCallControlId: "cc-1" }, NOW + EXPECTED_LEG_TTL_MS + 1)).toBeNull();
  });

  it("treats the custom header as a hint only", () => {
    expect(inviteHasAutoAnswerHeader({ customHeaders: [{ name: "X-PM-Auto-Answer", value: "1" }] })).toBe(true);
    expect(inviteHasAutoAnswerHeader({ customHeaders: [{ name: "X-Other", value: "1" }] })).toBe(false);
    expect(inviteIsColleagueCall({ customHeaders: [{ name: "x-pm-colleague-call", value: "1" }] })).toBe(true);
    expect(inviteIsColleagueCall({ customHeaders: [{ name: "X-PM-Auto-Answer", value: "1" }] })).toBe(false);
    expect(inviteIsColleagueCall({})).toBe(false);
    // The header alone never identifies a session, so it cannot match a leg.
    expect(matchExpectedLeg([], { customHeaders: [{ name: "X-PM-Auto-Answer", value: "1" }] }, NOW)).toBeNull();
  });
});

describe("early accept correlation (call-speed S3)", () => {
  const REQUEST = "6f1c2a4e-8b3d-4c5e-9f60-7a8b9c0d1e2f";
  const OTHER = "0b7e5d3c-1a2f-4e6d-8c9b-a0b1c2d3e4f5";
  const armed = rememberExpectedRequest([], { requestId: REQUEST, timingOperationId: REQUEST, at: NOW }, NOW);
  const own = (requestId = REQUEST, extra: Array<{ name: string; value: string }> = []) =>
    ({ telnyxCallControlId: "cc-own", customHeaders: [{ name: "X-PM-Auto-Answer", value: "1" }, { name: "X-PM-Request", value: requestId }, ...extra] });

  it("matches the own leg only by its exact request id together with the auto-answer header", () => {
    expect(matchExpectedRequest(armed, own(), NOW)?.requestId).toBe(REQUEST);
    expect(matchExpectedRequest(armed, { customHeaders: [{ name: "x-pm-auto-answer", value: "1" }, { name: "x-pm-request", value: REQUEST }] }, NOW)?.requestId).toBe(REQUEST);
    expect(matchExpectedRequest(armed, own(OTHER), NOW)).toBeNull();
    expect(matchExpectedRequest(armed, own(REQUEST.toUpperCase()), NOW)).toBeNull();
    // The request header without the server's auto-answer header is no permission.
    expect(matchExpectedRequest(armed, { customHeaders: [{ name: "X-PM-Request", value: REQUEST }] }, NOW)).toBeNull();
    // An ordinary auto-answer leg (pickup, supervision) carries no request identity.
    expect(matchExpectedRequest(armed, { customHeaders: [{ name: "X-PM-Auto-Answer", value: "1" }] }, NOW)).toBeNull();
    expect(matchExpectedRequest(armed, { telnyxCallControlId: "cc-own" }, NOW)).toBeNull();
  });

  it("never matches a colleague's call, a repeated header, an expired or an unarmed request", () => {
    expect(matchExpectedRequest(armed, own(REQUEST, [{ name: "X-PM-Colleague-Call", value: "1" }]), NOW)).toBeNull();
    expect(matchExpectedRequest(armed, own(REQUEST, [{ name: "X-PM-Request", value: REQUEST }]), NOW)).toBeNull();
    expect(inviteRequestId(own(REQUEST, [{ name: "X-PM-Request", value: OTHER }]))).toBeNull();
    expect(matchExpectedRequest(armed, own(), NOW + EXPECTED_REQUEST_TTL_MS - 1)?.requestId).toBe(REQUEST);
    expect(matchExpectedRequest(armed, own(), NOW + EXPECTED_REQUEST_TTL_MS)).toBeNull();
    expect(matchExpectedRequest([], own(), NOW)).toBeNull();
  });

  it("arms only a well-formed request id, once per id", () => {
    expect(rememberExpectedRequest([], { requestId: "", at: NOW }, NOW)).toEqual([]);
    expect(rememberExpectedRequest([], { requestId: "not-a-uuid", at: NOW }, NOW)).toEqual([]);
    expect(rememberExpectedRequest(armed, { requestId: REQUEST, at: NOW + 1 }, NOW + 1)).toEqual([{ requestId: REQUEST, at: NOW + 1 }]);
    expect(rememberExpectedRequest(armed, { requestId: OTHER, at: NOW + EXPECTED_REQUEST_TTL_MS }, NOW + EXPECTED_REQUEST_TTL_MS))
      .toEqual([{ requestId: OTHER, at: NOW + EXPECTED_REQUEST_TTL_MS }]);
  });

  it("leaves the existing leg correlation untouched by a request header", () => {
    // No armed leg: the request header satisfies neither the call-control id match nor the tiebreaker.
    expect(matchExpectedLeg([], own(), NOW)).toBeNull();
    expect(matchAutoAnswer([], own(), NOW)).toBeNull();
  });
});

describe("SDK surface", () => {
  it("keeps the structural SDK types assignable from @telnyx/webrtc", () => {
    // Compile-time contract: if Telnyx renames `telnyxIDs`, `answer`, `dtmf`,
    // `muteAudio` or the client's `connect`/`on`, this stops type-checking.
    const call: WebphoneSdkCall = {} as Call;
    const client: WebphoneSdkClient = {} as TelnyxRTC;
    expect(typeof call).toBe("object");
    expect(typeof client).toBe("object");
  });
});
