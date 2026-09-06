import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigateAfterDraftApproval, protectDraftBeforeUnload } from "./draft-unload";

let browser: EventTarget;

beforeEach(() => {
  vi.useFakeTimers();
  browser = Object.assign(new EventTarget(), { setTimeout, clearTimeout });
  vi.stubGlobal("window", browser);
  // Model forms mounted before the user requests a document navigation.
  browser.addEventListener("beforeunload", (event) => protectDraftBeforeUnload(event as BeforeUnloadEvent));
  browser.addEventListener("beforeunload", (event) => protectDraftBeforeUnload(event as BeforeUnloadEvent));
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function unload() {
  const event = new Event("beforeunload", { cancelable: true });
  browser.dispatchEvent(event);
  return event;
}

describe("draft approval for document navigation", () => {
  it("keeps ordinary reloads protected", () => {
    expect(unload().defaultPrevented).toBe(true);
  });

  it("approves the existing form listeners regardless of registration order, once only", () => {
    navigateAfterDraftApproval(() => expect(unload().defaultPrevented).toBe(false));
    expect(unload().defaultPrevented).toBe(true);
  });

  it("restores protection when the browser never starts navigation", () => {
    navigateAfterDraftApproval(() => {});
    vi.advanceTimersByTime(1_000);
    expect(unload().defaultPrevented).toBe(true);
  });

  it("restores protection when requesting navigation throws", () => {
    expect(() => navigateAfterDraftApproval(() => { throw new Error("blocked"); })).toThrow("blocked");
    expect(unload().defaultPrevented).toBe(true);
  });

  it("cannot suppress another unload guard or leave a canceled page unprotected", () => {
    const otherGuard = (event: Event) => event.preventDefault();
    browser.addEventListener("beforeunload", otherGuard);
    navigateAfterDraftApproval(() => expect(unload().defaultPrevented).toBe(true));
    browser.removeEventListener("beforeunload", otherGuard);
    expect(unload().defaultPrevented).toBe(true);
  });
});
