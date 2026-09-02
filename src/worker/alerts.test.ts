import { describe, expect, it } from "vitest";

import { consecutiveFailures } from "./alerts";

describe("consecutiveFailures", () => {
  it("counts only the newest uninterrupted failure streak", () => {
    expect(consecutiveFailures([{ status: "failed" }, { status: "dead" }, { status: "succeeded" }, { status: "failed" }])).toBe(2);
  });

  it("stops immediately after a successful run", () => {
    expect(consecutiveFailures([{ status: "succeeded" }, { status: "failed" }])).toBe(0);
  });
});
