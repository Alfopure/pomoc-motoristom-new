import { describe, expect, it } from "vitest";

import {
  browserCallSessionFenceMatches,
  browserCallSessionKey,
  captureBrowserCallSession,
  sameBrowserCallSession,
} from "./browser-call-session";

describe("browser call session fence", () => {
  it("allows an action only on the exact captured SIP dialog", () => {
    const callA = {};
    const fence = captureBrowserCallSession({ generation: 4, session: callA, status: "incoming" });

    expect(fence).toBeDefined();
    expect(browserCallSessionFenceMatches(
      fence!,
      { generation: 4, session: callA, status: "incoming" },
      ["incoming"],
    )).toBe(true);
  });

  it("does not decline a new call that arrived while the provider ended the previous one", () => {
    const callA = {};
    const callB = {};
    const fence = captureBrowserCallSession({ generation: 7, session: callA, status: "incoming" });

    expect(browserCallSessionFenceMatches(
      fence!,
      { generation: 9, session: callB, status: "incoming" },
      ["incoming"],
    )).toBe(false);
  });

  it("rejects an ended dialog and a status-changing action", () => {
    const session = {};
    const fence = captureBrowserCallSession({ generation: 2, session, status: "in_call" });

    expect(captureBrowserCallSession({ generation: 3, session: null, status: "ended" })).toBeUndefined();
    expect(browserCallSessionFenceMatches(
      fence!,
      { generation: 2, session, status: "in_call" },
      ["incoming"],
    )).toBe(false);
  });

  it("separates a new invitation from the previous browser presentation cache", () => {
    const oldSession = captureBrowserCallSession({ generation: 8, session: {}, status: "incoming" });
    const sameSession = { ...oldSession!, status: "in_call" as const };
    const nextSession = captureBrowserCallSession({ generation: 10, session: {}, status: "incoming" });

    expect(sameBrowserCallSession(oldSession, sameSession)).toBe(true);
    expect(sameBrowserCallSession(oldSession, nextSession)).toBe(false);
    expect(sameBrowserCallSession(oldSession, undefined)).toBe(false);
  });

  it("remounts call-bound UI between two consecutive calls to the same party", () => {
    const first = captureBrowserCallSession({ generation: 11, session: {}, status: "outgoing" });
    const second = captureBrowserCallSession({ generation: 12, session: {}, status: "outgoing" });

    expect(browserCallSessionKey(first)).not.toBe(browserCallSessionKey(second));
  });

  it("keeps one key for a whole dialog so mid-call state is not reset", () => {
    const ringing = captureBrowserCallSession({ generation: 5, session: {}, status: "incoming" });
    const answered = captureBrowserCallSession({ generation: 5, session: {}, status: "in_call" });

    expect(browserCallSessionKey(ringing)).toBe(browserCallSessionKey(answered));
    expect(browserCallSessionKey(undefined)).toBeUndefined();
  });
});
