import { describe, expect, it } from "vitest";
import { expandIncomingFlow, IncomingFlowValidationError, parseIncomingFlow, readIncomingFlow, type IncomingFlow } from "./incoming-flow";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ring = { id: id(1), type: "ring" as const, seconds: 20, people: [{ profileId: id(101), application: true, personalNumber: "+421910123456" }] };
const flow = (): IncomingFlow => ({ version: 1, steps: [structuredClone(ring)], ending: "hangup_message" });
function invalid(value: unknown, code: string) {
  try { parseIncomingFlow(value); throw new Error("unexpected acceptance"); }
  catch (error) { expect(error).toBeInstanceOf(IncomingFlowValidationError); expect((error as IncomingFlowValidationError).issues.some(issue => issue.code === code)).toBe(true); }
}
describe("incoming flow schema and finite expansion", () => {
  it("retains explicit application + personal destinations and detaches input", () => {
    const source = flow(); const parsed = parseIncomingFlow(source); expect(parsed).toEqual(source); expect(parsed.steps).not.toBe(source.steps);
  });
  it("expands earlier ringing steps in selected order with unique occurrences", () => {
    const source = flow(); source.steps.push({ id: id(2), type: "external", seconds: 30, number: "+421910123457" }, { id: id(3), type: "wait", minutes: 15 }, { id: id(4), type: "repeat", stepIds: [id(2), id(1)], times: 2 });
    const steps = expandIncomingFlow(parseIncomingFlow(source));
    expect(steps.map(row => row.sourceId)).toEqual([id(1), id(2), id(3), id(2), id(1), id(2), id(1)]);
    expect(new Set(steps.map(row => row.occurrenceId)).size).toBe(steps.length);
  });
  it.each([undefined, null, 1, [], "flow"])("rejects malformed root %s", value => invalid(value, "shape_invalid"));
  it("rejects unknown fields rather than dropping behavior", () => invalid({ ...flow(), loopForever: true }, "shape_invalid"));
  it("rejects future versions", () => invalid({ ...flow(), version: 2 }, "version_invalid"));
  it("rejects numeric strings and fractional timing", () => { for (const seconds of ["20", 20.5, 0, 121]) invalid({ ...flow(), steps: [{ ...ring, seconds }] }, "range_invalid"); });
  it("requires a destination, including explicit missing-number handling", () => invalid({ ...flow(), steps: [{ ...ring, people: [{ profileId: id(101), application: false, personalNumber: null }] }] }, "destination_required"));
  it("does not coerce application strings", () => invalid({ ...flow(), steps: [{ ...ring, people: [{ profileId: id(101), application: "false", personalNumber: null }] }] }, "type_invalid"));
  it("requires canonical E.164 numbers", () => invalid({ ...flow(), steps: [{ ...ring, people: [{ profileId: id(101), application: true, personalNumber: "0910 123 456" }] }] }, "number_invalid"));
  it("rejects duplicate operator and phone within a step", () => invalid({ ...flow(), steps: [{ ...ring, people: [ring.people[0], ring.people[0]] }] }, "duplicate_person"));
  it("rejects two owners of one ringing destination", () => invalid({ ...flow(), steps: [{ ...ring, people: [ring.people[0], { ...ring.people[0], profileId: id(102) }] }] }, "duplicate_number"));
  it("rejects case-insensitive duplicate IDs", () => invalid({ ...flow(), steps: [ring, ring] }, "duplicate_id"));
  it.each(["future", "self", "wait", "repeat"])("rejects %s repeat reference", mode => {
    const source = flow();
    source.steps.push({ id: id(2), type: "wait", minutes: 1 }, { id: id(3), type: "repeat", stepIds: [id(1)], times: 1 }, { id: id(4), type: "repeat", stepIds: [mode === "future" ? id(5) : mode === "self" ? id(4) : mode === "wait" ? id(2) : id(3)], times: 1 });
    invalid(source, "repeat_invalid");
  });
  it("bounds expanded steps before runtime starts ringing", () => {
    const source = flow(); source.steps = Array.from({ length: 18 }, (_, n) => ({ ...ring, id: id(n + 1) })); source.steps.push({ id: id(30), type: "repeat", stepIds: source.steps.map(step => step.id), times: 5 }); invalid(source, "expanded_too_long");
  });
  it("bounds total caller wait", () => invalid({ ...flow(), steps: [1, 2, 3].map(n => ({ id: id(n), type: "wait", minutes: 60 })) }, "duration_too_long"));
  it("preserves legacy wait JSON without silently adding a new audio policy", () => {
    const source = { ...flow(), steps: [{ id: id(1), type: "wait", minutes: 2 }] };
    expect(parseIncomingFlow(source)).toEqual(source);
  });
  it.each(["music", "announcement", "callback"] as const)("accepts and detaches explicit %s policy", mode => {
    for (const intervalSeconds of [15, 30, 60]) {
      const policy = { mode, intervalSeconds };
      const source = { ...flow(), steps: [{ id: id(1), type: "wait", minutes: 2, policy }] };
      const parsed = parseIncomingFlow(source);
      expect(parsed).toEqual(source);
      expect(parsed.steps[0]).not.toBe(source.steps[0]);
    }
  });
  it.each([null, { mode: "silent", intervalSeconds: 30 }, { mode: "music", intervalSeconds: "30" }, { mode: "callback", intervalSeconds: 16 }])("rejects invalid wait policy %#", policy => {
    invalid({ ...flow(), steps: [{ id: id(1), type: "wait", minutes: 2, policy }] }, "wait_policy_invalid");
  });
  it("rejects missing or extra wait policy behavior", () => {
    for (const policy of [{ mode: "music" }, { mode: "callback", intervalSeconds: 15, autoCall: true }])
      invalid({ ...flow(), steps: [{ id: id(1), type: "wait", minutes: 2, policy }] }, "shape_invalid");
  });
  it("returns null for missing or invalid stored flows", () => { expect(readIncomingFlow(undefined)).toBeNull(); expect(readIncomingFlow({ version: 2 })).toBeNull(); expect(readIncomingFlow(flow())).toEqual(flow()); });
});
