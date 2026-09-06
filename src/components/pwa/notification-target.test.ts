import { describe, expect, it } from "vitest";
import { notificationTarget } from "./notification-target";

const origin = "https://dispatch-copy.example";
const session = "4d821f21-cf1c-4a12-aa04-36f64c3eab96";

describe("notification targets", () => {
  it("keeps task links and accepts only UUID call sessions", () => {
    expect(notificationTarget("/?task=task-1", origin)).toEqual({ kind: "task", id: "task-1" });
    expect(notificationTarget(`/?call=${session.toUpperCase()}&next=https://untrusted.example`, origin)).toEqual({ kind: "call", id: session });
    expect(notificationTarget("/", origin)).toEqual({ kind: "settings" });
  });

  it.each([
    `https://untrusted.example/?call=${session}`, `https://user@dispatch-copy.example/?call=${session}`,
    "/api/telephony/calls", "javascript:alert(1)", "/?call=not-a-session", "/?task=%3Cscript%3E",
    `/?call=${session}&task=task-1`, `/?call=${session}&call=${session}`, "/?task=task-1&task=task-2", "/?call=",
  ])("ignores unsafe or ambiguous link %s", (url) => {
    expect(notificationTarget(url, origin)).toBeNull();
  });
});
