import { describe, expect, it } from "vitest";

import { TelnyxWebphone, isAuthFailure, type WebphoneSdkCall, type WebphoneSdkClient, type WebphoneSdkNotification } from "./telnyx-webphone";
import type { TelephonyJsonResult } from "./client-request";

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

function harness(options: { token?: TelephonyJsonResult<unknown>; heartbeat?: () => TelephonyJsonResult<unknown> } = {}) {
  const requests: Request[] = [];
  const timers: Array<{ id: number; handler: () => void; delayMs: number }> = [];
  let nextTimer = 1;
  const client = new FakeClient();

  const phone = new TelnyxWebphone({
    silent: true,
    now: () => Date.parse("2026-09-03T08:00:00.000Z"),
    createClient: () => client,
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

describe("TelnyxWebphone", () => {
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
    const call = fakeCall();
    h.client.emit("telnyx.notification", { type: "callUpdate", call } satisfies WebphoneSdkNotification);

    expect(call.answered).toBe(true);
    expect(h.phone.getSnapshot().call?.sessionId).toBe("sess-1");
    expect(h.phone.getSnapshot().call?.active).toBe(true);
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
});
