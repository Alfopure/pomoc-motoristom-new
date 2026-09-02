import { describe, expect, it } from "vitest";
import {
  createBrowserSipCallAttempt,
  safeSipStatusCode,
} from "@/lib/telephony/webphone-call-attempt";

describe("browser SIP call attempt", () => {
  it("keeps the first terminal SIP result immutable", async () => {
    const controller = createBrowserSipCallAttempt();

    expect(controller.settle({ outcome: "rejected", statusCode: 486 })).toBe(true);
    expect(controller.settle({ outcome: "accepted" })).toBe(false);
    expect(controller.settled()).toBe(true);
    await expect(controller.attempt.finalResponse).resolves.toEqual({
      outcome: "rejected",
      statusCode: 486,
    });
  });

  it.each([
    [486, 486],
    [699, 699],
    [200, undefined],
    [700, undefined],
    [486.5, undefined],
    ["486", undefined],
  ])("normalizes a safe SIP status %j", (input, expected) => {
    expect(safeSipStatusCode(input)).toBe(expected);
  });
});
