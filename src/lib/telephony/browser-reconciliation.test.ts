import { describe, expect, it } from "vitest";
import { BrowserReconciliationGate } from "./browser-reconciliation";

describe("BrowserReconciliationGate", () => {
  it("keeps one in-flight verification across repeated foreground hints and queues only one fresh check", () => {
    const gate = new BrowserReconciliationGate(() => 0);
    expect(gate.begin("leg")).toBe(true);
    for (let index = 0; index < 20; index++) { gate.invalidate(); expect(gate.begin("leg")).toBe(false); }
    gate.finish("leg", true);
    expect(gate.begin("leg")).toBe(true);
    expect(gate.begin("leg")).toBe(false);
    gate.finish("leg", true);
    expect(gate.begin("leg")).toBe(false);
  });

  it("backs failed or busy verification off and stops after six attempts", () => {
    let now = 0;
    const gate = new BrowserReconciliationGate(() => now);
    for (let attempt = 0; attempt < 6; attempt++) {
      expect(gate.begin("leg")).toBe(true);
      gate.finish("leg", false, 1_000);
      expect(gate.begin("leg")).toBe(false);
      now += Math.min(15_000, 1_000 * 2 ** attempt) - 1;
      expect(gate.begin("leg")).toBe(false);
      now++;
    }
    expect(gate.exhausted("leg")).toBe(true);
    expect(gate.begin("leg")).toBe(false);
    gate.invalidate();
    expect(gate.begin("leg")).toBe(true);
  });

  it("a successful verification needs a later explicit hint and never resets another leg", () => {
    const gate = new BrowserReconciliationGate(() => 0);
    expect(gate.begin("first")).toBe(true);
    gate.finish("first", true);
    expect(gate.begin("second")).toBe(true);
    gate.invalidate("first");
    expect(gate.begin("first")).toBe(true);
    expect(gate.begin("second")).toBe(false);
  });

  it("pending failed retries retain their backoff across visibility hints", () => {
    let now = 0;
    const gate = new BrowserReconciliationGate(() => now);
    expect(gate.begin("leg")).toBe(true);
    gate.finish("leg", false, 2_000);
    gate.invalidate();
    now = 1_999;
    expect(gate.begin("leg")).toBe(false);
    now++;
    expect(gate.begin("leg")).toBe(true);
  });
});
