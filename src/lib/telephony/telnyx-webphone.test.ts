import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Call } from "@telnyx/webrtc";

import { TelnyxWebphone, isAuthFailure, type TelnyxWebphoneOptions, type WebphoneSdkCall, type WebphoneSdkClient, type WebphoneSdkNotification } from "./telnyx-webphone";
import type { TelephonyJsonResult } from "./client-request";
import { EXPECTED_LEG_TTL_MS } from "./webphone-model";

/**
 * The controller is exercised through its injected seams only: no jsdom, no
 * socket, no audio. `document`/`window`/`Notification` are absent in the node
 * environment, which is exactly the "headless" path the class must tolerate.
 */

type Handler = (payload: unknown) => void;

class FakeClient implements WebphoneSdkClient {
  handlers = new Map<string, Handler[]>();
  connected = false;
  disconnected = false;
  remoteElement: unknown = "";

  on(event: string, callback: (payload: never) => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(callback as Handler);
    this.handlers.set(event, list);
    return this;
  }

  off(event: string) {
    this.handlers.delete(event);
    return this;
  }

  async connect() {
    this.connected = true;
  }

  async disconnect() {
    this.disconnected = true;
  }

  emit(event: string, payload?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

function fakeCall(overrides: Partial<WebphoneSdkCall> = {}): WebphoneSdkCall & { answered: boolean; hungUp: boolean; digits: string[] } {
  const call = {
    id: "call-1",
    state: "ringing",
    direction: "inbound",
    options: { remoteCallerNumber: "+421900111222" },
    telnyxIDs: { telnyxCallControlId: "cc-1", telnyxSessionId: "ts-1", telnyxLegId: "leg-1" },
    isAudioMuted: false,
    answered: false,
    hungUp: false,
    digits: [] as string[],
    answer() {
      call.answered = true;
      call.state = "active";
    },
    hangup() {
      call.hungUp = true;
      call.state = "hangup";
    },
    muteAudio() {
      call.isAudioMuted = true;
    },
    unmuteAudio() {
      call.isAudioMuted = false;
    },
    dtmf(digit: string) {
      call.digits.push(digit);
    },
    ...overrides,
  };
  return call as WebphoneSdkCall & { answered: boolean; hungUp: boolean; digits: string[] };
}

type Request = { url: string; body: unknown };

function harness(options: { token?: TelephonyJsonResult<unknown>; heartbeat?: () => TelephonyJsonResult<unknown>; now?: () => number; createClient?: TelnyxWebphoneOptions["createClient"] } = {}) {
  const requests: Request[] = [];
  const timers: Array<{ id: number; handler: () => void; delayMs: number }> = [];
  let nextTimer = 1;
  const client = new FakeClient();

  const phone = new TelnyxWebphone({
    silent: true,
    now: options.now ?? (() => Date.parse("2026-09-03T08:00:00.000Z")),
    createClient: options.createClient ?? (() => client),
    setTimeout: (handler, delayMs) => {
      const id = nextTimer++;
      timers.push({ id, handler, delayMs });
      return id;
    },
    clearTimeout: (id) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    requestJson: async (url, init) => {
      requests.push({ url, body: init.body });
      if (url.includes("/webphone/token")) {
        return (options.token ?? {
          ok: true,
          status: 200,
          body: {
            token: "jwt",
            expiresAt: new Date(Date.parse("2026-09-03T08:00:00.000Z") + 3_600_000).toISOString(),
            deviceSessionId: "device-1",
            sipUsername: "gencred1",
          },
        }) as never;
      }
      return (options.heartbeat?.() ?? { ok: true, status: 200, body: { ok: true } }) as never;
    },
  });

  return {
    client,
    phone,
    requests,
    timers,
    runTimer: (predicate: (timer: { delayMs: number }) => boolean) => {
      const timer = timers.find(predicate);
      if (!timer) throw new Error("no matching timer");
      timers.splice(timers.indexOf(timer), 1);
      timer.handler();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Real EventTargets exercise listener registration/cleanup without a browser or microphone. */
function audioDom() {
  class FakeAudio extends EventTarget {
    id = "";
    autoplay = false;
    style = { display: "" };
    srcObject: object | null = null;
    paused = true;
    setAttribute = vi.fn();
    remove = vi.fn();
    pause = vi.fn(() => { this.paused = true; this.dispatchEvent(new Event("pause")); });
    play = vi.fn(async () => { this.paused = false; this.dispatchEvent(new Event("playing")); });
  }
  const audio = new FakeAudio();
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    createElement: vi.fn(() => audio),
    body: { appendChild: vi.fn() },
  });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", new EventTarget());
  return { audio, document };
}

describe("TelnyxWebphone", () => {
  it("keeps the SDK call seam compatible with its asynchronous answer API", () => {
    expectTypeOf<Call>().toMatchTypeOf<WebphoneSdkCall>();
  });

  it("mints a token, connects and reports the registration", async () => {
    const h = harness();
    h.phone.start();
    await flush();

    expect(h.requests[0]?.url).toContain("/api/telephony/webphone/token");
    expect(h.client.connected).toBe(true);
    expect(h.phone.getSnapshot().status).toBe("connecting");

    h.client.emit("telnyx.ready");
    expect(h.phone.getSnapshot().status).toBe("registered");
    expect(h.phone.getSnapshot().registration.label).toBe("Registrované");
    expect(h.phone.getSnapshot().sipUsername).toBe("gencred1");
    expect(h.requests.at(-1)).toEqual({ url: "/api/telephony/devices/heartbeat", body: JSON.stringify({ deviceSessionId: "device-1", registrationState: "registered" }) });
  });

  it("stays in the not-configured mode when the token route answers 503", async () => {
    const h = harness({ token: { ok: false, status: 503, body: { error: "Telefónia nie je nakonfigurovaná." } } });
    h.phone.start();
    await flush();

    expect(h.phone.getSnapshot().status).toBe("not_configured");
    expect(h.phone.getSnapshot().message).toBe("Telefónia nie je nakonfigurovaná.");
    expect(h.client.connected).toBe(false);
  });

  it("auto-answers the invite that belongs to a dial this tab started", async () => {
    const h = harness();
    h.phone.start();
    await flush();
    h.client.emit("telnyx.ready");

    h.phone.expectOperatorLeg({ callControlId: "cc-1", sessionId: "sess-1" });
    expect(h.phone.getSnapshot()).toMatchObject({ call: null, pendingOperatorLegs: 1 });
    const call = fakeCall();
    h.client.emit("telnyx.notification", { type: "callUpdate", call } satisfies WebphoneSdkNotification);

    expect(call.answered).toBe(true);
    expect(h.phone.getSnapshot().call?.sessionId).toBe("sess-1");
    expect(h.phone.getSnapshot().call?.active).toBe(true);
    expect(h.phone.getSnapshot().pendingOperatorLegs).toBe(0);
  });

  it("publishes pending legs before an invite and retains other concurrent legs after one connects", async () => {
    const h = harness();
    h.phone.start();
    await flush();
    h.client.emit("telnyx.ready");
    const pendingCounts: number[] = [];
    h.phone.subscribe((snapshot) => pendingCounts.push(snapshot.pendingOperatorLegs ?? 0));

    h.phone.expectOperatorLeg({ callControlId: "cc-1", sessionId: "sess-1" });
    h.phone.expectOperatorLeg({ callControlId: "cc-2", sessionId: "sess-2" });
    expect(pendingCounts).toEqual([1, 2]);

    const call = fakeCall();
    h.client.emit("telnyx.notification", { type: "callUpdate", call } satisfies WebphoneSdkNotification);
    expect(h.phone.getSnapshot()).toMatchObject({ pendingOperatorLegs: 1, call: { active: true } });
    call.hangup();
    h.client.emit("telnyx.notification", { type: "callUpdate", call } satisfies WebphoneSdkNotification);
    expect(h.phone.getSnapshot()).toMatchObject({ pendingOperatorLegs: 1, call: null });
  });

  it("expires missing invites on their existing TTL and publishes each remaining count", async () => {
    let now = Date.parse("2026-09-03T08:00:00.000Z");
    const h = harness({ now: () => now });
    h.phone.start();
    await flush();
    h.client.emit("telnyx.ready");
    const pendingCounts: number[] = [];
    h.phone.subscribe((snapshot) => pendingCounts.push(snapshot.pendingOperatorLegs ?? 0));

    h.phone.expectOperatorLeg({ callControlId: "cc-1", sessionId: "sess-1" });
    now += EXPECTED_LEG_TTL_MS / 2;
    h.phone.expectOperatorLeg({ callControlId: "cc-2", sessionId: "sess-2" });

    now += EXPECTED_LEG_TTL_MS / 2;
    h.runTimer((timer) => timer.delayMs === EXPECTED_LEG_TTL_MS / 2);
    expect(h.phone.getSnapshot().pendingOperatorLegs).toBe(1);

    now += EXPECTED_LEG_TTL_MS / 2;
    h.runTimer((timer) => timer.delayMs === EXPECTED_LEG_TTL_MS / 2);
    expect(h.phone.getSnapshot()).toMatchObject({ pendingOperatorLegs: 0, call: null });
    expect(pendingCounts).toEqual([1, 2, 1, 0]);
  });

  it("clears queued legs and their expiry timer when the browser phone stops", async () => {
    const h = harness();
    h.phone.start();
    await flush();
    h.phone.expectOperatorLeg({ callControlId: "cc-1", sessionId: "sess-1" });
    expect(h.phone.getSnapshot().pendingOperatorLegs).toBe(1);

    h.phone.stop();

    expect(h.phone.getSnapshot()).toMatchObject({ pendingOperatorLegs: 0, call: null, status: "idle" });
    expect(h.timers).toHaveLength(0);
  });

  it("answers an invite that arrived before the dial response registered its leg", async () => {
    const h = harness();
    h.phone.start();
    await flush();
    h.client.emit("telnyx.ready");

    // The SIP invite wins the race against `POST /api/telephony/calls`.
    const call = fakeCall();
    h.client.emit("telnyx.notification", { type: "callUpdate", call } satisfies WebphoneSdkNotification);
    expect(call.answered).toBe(false);

    h.phone.expectOperatorLeg({ callControlId: "cc-1", sessionId: "sess-1" });

    expect(call.answered).toBe(true);
    expect(h.phone.getSnapshot().call?.sessionId).toBe("sess-1");
  });

  it("uses the X-PM-Auto-Answer header only as a tiebreaker for an outstanding leg", async () => {
    const h = harness();
    h.phone.start();
    await flush();
    h.client.emit("telnyx.ready");

    // The header alone is not enough: it carries no session identity, and this
    // tab has asked for no leg.
    const stray = fakeCall({
      id: "call-stray",
      telnyxIDs: { telnyxCallControlId: "cc-stray", telnyxSessionId: "ts", telnyxLegId: "leg" },
      options: { remoteCallerNumber: "+421900111222", customHeaders: [{ name: "X-PM-Auto-Answer", value: "1" }] },
    });
    h.client.emit("telnyx.notification", { type: "callUpdate", call: stray } satisfies WebphoneSdkNotification);
    expect(stray.answered).toBe(false);
    expect(h.phone.getSnapshot().call).toMatchObject({ id: "call-stray", ringing: true, sessionId: null });
    stray.hangup();
    h.client.emit("telnyx.notification", { type: "callUpdate", call: stray } satisfies WebphoneSdkNotification);

    // With exactly one leg this tab asked for outstanding, the header decides —
    // the pickup invite can arrive before its call-control id does.
    h.phone.expectOperatorLeg({ callControlId: "cc-pickup", sessionId: "sess-9" });
    const call = fakeCall({
      telnyxIDs: { telnyxCallControlId: "cc-other-id", telnyxSessionId: "ts", telnyxLegId: "leg" },
      options: { remoteCallerNumber: "+421900111222", customHeaders: [{ name: "X-PM-Auto-Answer", value: "1" }] },
    });
    h.client.emit("telnyx.notification", { type: "callUpdate", call } satisfies WebphoneSdkNotification);

    expect(call.answered).toBe(true);
    expect(h.phone.getSnapshot().call?.active).toBe(true);
    expect(h.phone.getSnapshot().call?.sessionId).toBe("sess-9");
  });

  it("leaves an unexpected invite ringing for the operator", async () => {
    const h = harness();
    h.phone.start();
    await flush();
    h.client.emit("telnyx.ready");

    const call = fakeCall({ telnyxIDs: { telnyxCallControlId: "cc-9", telnyxSessionId: "ts", telnyxLegId: "leg" } });
    h.client.emit("telnyx.notification", { type: "callUpdate", call } satisfies WebphoneSdkNotification);

    expect(call.answered).toBe(false);
    expect(h.phone.getSnapshot().call?.ringing).toBe(true);
    expect(h.phone.getSnapshot().call?.number).toBe("+421900111222");

    h.phone.answer();
    expect(call.answered).toBe(true);
    expect(h.phone.getSnapshot().call?.sessionId).toBeNull();

    h.phone.sendDtmf("5");
    h.phone.toggleMute();
    expect(call.digits).toEqual(["5"]);
    expect(h.phone.getSnapshot().call?.muted).toBe(true);
  });

  it("disconnects the tab when the heartbeat is refused with 409", async () => {
    const h = harness({ heartbeat: () => ({ ok: false, status: 409, body: { error: "Telefón bol prihlásený v inom okne." } }) });
    h.phone.start();
    await flush();
    h.client.emit("telnyx.ready");

    h.runTimer((timer) => timer.delayMs === 30_000);
    await flush();

    expect(h.phone.getSnapshot().status).toBe("superseded");
    expect(h.client.disconnected).toBe(true);
    expect(h.phone.getSnapshot().registration.tone).toBe("error");
  });

  it("re-mints the token when the refresh timer fires", async () => {
    const h = harness();
    h.phone.start();
    await flush();
    h.client.emit("telnyx.ready");

    const tokenRequests = () => h.requests.filter((request) => request.url.includes("/webphone/token")).length;
    expect(tokenRequests()).toBe(1);
    h.runTimer((timer) => timer.delayMs === 1_800_000);
    await flush();
    expect(tokenRequests()).toBe(2);
    // The socket is not torn down for a refresh: a live call must survive it.
    expect(h.client.disconnected).toBe(false);
    expect(h.phone.getSnapshot().status).toBe("registered");
  });

  it("recognises auth failures that must re-mint rather than replay the token", () => {
    expect(isAuthFailure("Unauthorized")).toBe(true);
    expect(isAuthFailure("Token expired")).toBe(true);
    expect(isAuthFailure("ICE failed")).toBe(false);
    expect(isAuthFailure(null)).toBe(false);
  });

  it("blocks duplicate manual/automatic answers while media negotiation is pending", async () => {
    const h = harness();
    h.phone.start();
    await flush();
    const answer = deferred<void>();
    const answerSdk = vi.fn(() => answer.promise);
    const call = fakeCall({ answer: answerSdk });
    h.phone.expectOperatorLeg({ callControlId: "cc-1", sessionId: "sess-1" });
    h.client.emit("telnyx.notification", { type: "callUpdate", call });
    expect(h.phone.getSnapshot().answering).toBe(true);

    h.phone.answer();
    h.client.emit("telnyx.notification", { type: "callUpdate", call });
    expect(answerSdk).toHaveBeenCalledTimes(1);

    answer.resolve();
    await flush();
    h.phone.answer();
    expect(answerSdk).toHaveBeenCalledTimes(1);
    expect(h.phone.getSnapshot().answering).toBe(false);
    h.phone.stop();
  });

  it("catches a rejected answer, keeps registration, and allows the same ringing call to retry", async () => {
    const h = harness();
    h.phone.start();
    await flush();
    h.client.emit("telnyx.ready");
    const answerSdk = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"))
      .mockResolvedValueOnce();
    const call = fakeCall({ answer: answerSdk });
    h.client.emit("telnyx.notification", { type: "callUpdate", call });
    h.phone.answer();
    await flush();

    expect(h.phone.getSnapshot()).toMatchObject({ status: "registered", answering: false, call: { ringing: true } });
    expect(h.phone.getSnapshot().callError).toContain("Mikrofón je zablokovaný");
    expect(h.client.disconnected).toBe(false);
    h.phone.answer();
    await flush();
    expect(answerSdk).toHaveBeenCalledTimes(2);
    expect(h.phone.getSnapshot().callError).toBeNull();
    h.phone.stop();
  });

  it.each(["ended", "stopped"])("ignores an answer rejection after its call is %s", async (ending) => {
    const h = harness();
    h.phone.start();
    await flush();
    const answer = deferred<void>();
    const call = fakeCall({ answer: () => answer.promise });
    h.client.emit("telnyx.notification", { type: "callUpdate", call });
    h.phone.answer();
    if (ending === "stopped") h.phone.stop();
    else {
      call.state = "hangup";
      h.client.emit("telnyx.notification", { type: "callUpdate", call });
    }
    answer.reject(new DOMException("denied", "NotAllowedError"));
    await flush();
    expect(h.phone.getSnapshot()).toMatchObject({ call: null, answering: false, callError: null });
    h.phone.stop();
  });

  it.each([42001, 42002, 42003, 40002, 44001, 47001])("keeps a healthy registration for call-specific SDK error %s", async (code) => {
    const h = harness();
    h.phone.start();
    await flush();
    h.client.emit("telnyx.ready");
    const call = fakeCall();
    h.client.emit("telnyx.notification", { type: "callUpdate", call });
    h.client.emit("telnyx.error", { error: { code, message: "SDK call failure" }, callId: call.id });
    expect(h.phone.getSnapshot().status).toBe("registered");
    expect(h.phone.getSnapshot().callError).toBeTruthy();
    expect(h.client.disconnected).toBe(false);
    call.state = "hangup";
    h.client.emit("telnyx.notification", { type: "callUpdate", call });
    expect(h.phone.getSnapshot().callError).toBeTruthy();
    h.phone.dismissCallError();
    expect(h.phone.getSnapshot().callError).toBeNull();
    h.phone.stop();
  });

  it("ignores old call errors and retains network-error recovery", async () => {
    const h = harness();
    h.phone.start();
    await flush();
    h.client.emit("telnyx.ready");
    h.client.emit("telnyx.notification", { type: "callUpdate", call: fakeCall() });
    h.client.emit("telnyx.error", { error: { code: 42001 }, callId: "old-call" });
    expect(h.phone.getSnapshot().callError).toBeNull();
    h.client.emit("telnyx.error", { error: { code: 45002, message: "Socket lost" } });
    expect(h.phone.getSnapshot().status).toBe("reconnecting");
    expect(h.client.disconnected).toBe(true);
    h.phone.stop();
  });

  it("does not connect a delayed SDK client after stop or accept its later events", async () => {
    const created = deferred<WebphoneSdkClient>();
    const client = new FakeClient();
    const h = harness({ createClient: () => created.promise });
    h.phone.start();
    await flush();
    h.phone.stop();
    created.resolve(client);
    await flush();
    client.emit("telnyx.ready");
    client.emit("telnyx.notification", { type: "callUpdate", call: fakeCall() });
    expect(client.connected).toBe(false);
    expect(client.disconnected).toBe(true);
    expect(h.phone.getSnapshot()).toMatchObject({ status: "idle", call: null });
  });

  it("cleans up a client whose connect promise rejects before retrying", async () => {
    const client = new FakeClient();
    client.connect = vi.fn(async () => { throw new Error("socket unavailable"); });
    const h = harness({ createClient: () => client });
    h.phone.start();
    await flush();
    expect(h.phone.getSnapshot().status).toBe("reconnecting");
    expect(client.disconnected).toBe(true);
    expect(client.handlers.size).toBe(0);
    client.emit("telnyx.ready");
    expect(h.phone.getSnapshot().status).toBe("reconnecting");
    h.phone.stop();
  });

  it("exposes blocked remote autoplay, retries from a tap and resumes on foreground without reconnecting", async () => {
    const { audio, document } = audioDom();
    audio.play.mockRejectedValueOnce(new DOMException("gesture required", "NotAllowedError"));
    const h = harness();
    h.phone.start();
    await flush();
    h.client.emit("telnyx.ready");
    audio.srcObject = {};
    h.client.emit("telnyx.notification", { type: "callUpdate", call: fakeCall({ state: "active" }) });
    await flush();
    expect(h.phone.getSnapshot().audioBlocked).toBe(true);

    await h.phone.resumeAudio();
    expect(h.phone.getSnapshot().audioBlocked).toBe(false);
    audio.pause();
    expect(h.phone.getSnapshot().audioBlocked).toBe(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(h.phone.getSnapshot().audioBlocked).toBe(false);
    expect(audio.play).toHaveBeenCalledTimes(3);
    expect(h.client.disconnected).toBe(false);
    expect(h.requests.filter((request) => request.url.includes("/webphone/token"))).toHaveLength(1);

    h.phone.stop();
    const plays = audio.play.mock.calls.length;
    audio.dispatchEvent(new Event("canplay"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(audio.play).toHaveBeenCalledTimes(plays);
    expect(audio.remove).toHaveBeenCalledTimes(1);
    expect(audio.srcObject).toBeNull();
  });

  it("waits for attached remote media and ignores a late autoplay rejection after hangup", async () => {
    const { audio } = audioDom();
    const h = harness();
    h.phone.start();
    await flush();
    const call = fakeCall({ state: "active" });
    h.client.emit("telnyx.notification", { type: "callUpdate", call });
    expect(audio.play).not.toHaveBeenCalled();
    const play = deferred<void>();
    audio.play.mockImplementationOnce(() => play.promise);
    audio.srcObject = {};
    audio.dispatchEvent(new Event("loadedmetadata"));
    expect(audio.play).toHaveBeenCalledTimes(1);
    call.state = "hangup";
    h.client.emit("telnyx.notification", { type: "callUpdate", call });
    play.reject(new DOMException("gesture required", "NotAllowedError"));
    await flush();
    expect(h.phone.getSnapshot()).toMatchObject({ call: null, audioBlocked: false });
    h.phone.stop();
  });

  it("does not ask for notification permission when unlocking call sound", async () => {
    const requestPermission = vi.fn();
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    const phone = new TelnyxWebphone();
    await phone.unlockAudio();
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
