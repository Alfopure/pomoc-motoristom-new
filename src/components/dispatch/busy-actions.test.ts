import { describe, expect, it } from "vitest";

import {
  busyActionBlocks,
  busyActionDeadlineMs,
  busyActionScope,
  callScopeBusy,
  phoneScopeBusy,
  WAITING_PICKUP_PHASE_DEADLINE_MS,
} from "./busy-actions";

const CALL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CALL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("busy action scopes", () => {
  it("treats every action that dials as the one browser phone", () => {
    expect(busyActionScope(`${CALL_A}:call_back`)).toBe("phone");
    expect(busyActionScope("quick:contact-1")).toBe("phone");
    expect(phoneScopeBusy(`${CALL_A}:call_back`)).toBe(true);
    expect(phoneScopeBusy(`${CALL_A}:link`)).toBe(false);
  });

  it("scopes bookkeeping to its own call", () => {
    expect(busyActionScope(`${CALL_A}:link`)).toBe(`call:${CALL_A}`);
    expect(busyActionScope(`${CALL_A}:callback`)).toBe(`call:${CALL_A}`);
    expect(callScopeBusy(`${CALL_A}:link`, CALL_A)).toBe(true);
    expect(callScopeBusy(`${CALL_A}:link`, CALL_B)).toBe(false);
  });

  it("does not let linking a case block dialling, or one call block another", () => {
    // This was the reported symptom: a single global lock meant any action
    // disabled every dial button in history and the whole phonebook.
    expect(busyActionBlocks(`${CALL_A}:link`, `${CALL_B}:call_back`)).toBe(false);
    expect(busyActionBlocks(`${CALL_A}:link`, `${CALL_B}:link`)).toBe(false);
    expect(busyActionBlocks("workplace:recover", `${CALL_A}:link`)).toBe(false);
  });

  it("still blocks two actions that contend for the same resource", () => {
    expect(busyActionBlocks(`${CALL_A}:call_back`, "quick:contact-1")).toBe(true);
    expect(busyActionBlocks(`${CALL_A}:link`, `${CALL_A}:callback`)).toBe(true);
    expect(busyActionBlocks("workplace:recover", "workplace:recover")).toBe(true);
  });

  it("treats nothing as busy when no action is running", () => {
    expect(busyActionScope(null)).toBeNull();
    expect(phoneScopeBusy(null)).toBe(false);
    expect(busyActionBlocks(null, `${CALL_A}:link`)).toBe(false);
  });

  it("gives the phone enough room to outlast browser SIP confirmation", () => {
    // confirmAuditedBrowserSipCall waits up to 75 s for VIPTel; releasing the
    // lock earlier would let a second dial start against the same dialog.
    expect(busyActionDeadlineMs("phone")).toBeGreaterThan(75_000);
    expect(busyActionDeadlineMs(`call:${CALL_A}`)).toBeLessThan(busyActionDeadlineMs("phone"));
    expect(busyActionDeadlineMs(null)).toBe(0);
  });
});

describe("waiting call pickup deadlines", () => {
  it("bounds every phase, not only the one that used to have a watchdog", () => {
    const phases = Object.keys(WAITING_PICKUP_PHASE_DEADLINE_MS);
    expect(phases.sort()).toEqual(["answering", "redirecting", "releasing_current", "waiting_for_phone"]);
    for (const value of Object.values(WAITING_PICKUP_PHASE_DEADLINE_MS)) {
      expect(value).toBeGreaterThan(0);
    }
  });

  it("lets the redirect phase outlast command confirmation", () => {
    expect(WAITING_PICKUP_PHASE_DEADLINE_MS.redirecting)
      .toBeGreaterThan(WAITING_PICKUP_PHASE_DEADLINE_MS.waiting_for_phone);
    expect(WAITING_PICKUP_PHASE_DEADLINE_MS.redirecting)
      .toBeGreaterThan(WAITING_PICKUP_PHASE_DEADLINE_MS.releasing_current);
  });
});
