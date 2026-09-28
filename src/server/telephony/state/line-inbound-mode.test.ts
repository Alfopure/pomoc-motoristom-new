import { describe, expect, it } from "vitest";
import { lineInboundMode, lineModeBehaviour } from "./types";

describe("per-number inbound routing", () => {
  it("inherits the organisation mode when the number has no override", () => {
    expect(lineInboundMode({ inbound_call_mode: null })).toBeNull();
    expect(lineModeBehaviour(null, "queue_first")).toEqual({ inboundCallMode: "queue_first", strategyOverride: null });
  });

  it("uses explicit ring modes ahead of a queue-first default", () => {
    expect(lineModeBehaviour("ring_first", "queue_first")).toEqual({ inboundCallMode: "ring_first", strategyOverride: null });
    expect(lineModeBehaviour("ring_all", "queue_first")).toEqual({ inboundCallMode: "ring_first", strategyOverride: "all" });
    expect(lineModeBehaviour("ring_ordered", "queue_first")).toEqual({ inboundCallMode: "ring_first", strategyOverride: "ordered" });
  });

  it("ignores unknown metadata rather than changing the route", () => {
    expect(lineInboundMode({ inbound_call_mode: "unexpected" })).toBeNull();
    expect(lineInboundMode(["queue_first"])).toBeNull();
  });
});
