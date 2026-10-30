import { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { CallJourney, CallJourneysResponse } from "@/lib/telephony/call-journey";

// Keep selection across resource snapshots without a browser/polling dependency.
const harness = vi.hoisted(() => ({
  selected: null as string | null,
  effects: [] as (() => void)[],
  data: null as CallJourneysResponse | null,
}));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useState: () => [harness.selected, (value: string | null) => { harness.selected = value; }],
  useEffect: (effect: () => void) => { harness.effects.push(effect); },
}));
vi.mock("../use-call-journey", () => ({
  useCallJourneyClock: () => Date.parse("2026-10-04T10:00:10Z"),
  useCallJourneyResource: () => ({ data: harness.data, loading: false, error: null, observedAt: null, refresh: vi.fn() }),
}));
import { IncomingFlowMonitor } from "./IncomingFlowMonitor";
import { CallJourneyCard, CallJourneySnapshotCard } from "../CallJourney";

function call(sessionId: string): CallJourney {
  return { version: 1, sessionId, callId: null, lineId: "line", direction: "inbound", callerNumber: "+421900000001", calledNumber: null, phase: "routing", sessionState: "ringing", sessionVersion: 1, asOf: "2026-10-04T10:00:10Z", customerActive: true, sessionActive: true, startedAt: "2026-10-04T10:00:00Z", answeredAt: null, endedAt: null, flow: { source: "incoming_flow", signature: "saved" }, currentOccurrenceId: null, coverage: "complete", truncated: false, occurrences: [], events: [], callback: null };
}
function elements(node: ReactNode): React.ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function render(calls: CallJourney[] | null) {
  harness.data = calls === null ? null : { ok: true, calls, truncated: false } as CallJourneysResponse;
  const tree = IncomingFlowMonitor({ lineId: "line", savedFlow: null, dirty: false });
  for (const effect of harness.effects.splice(0)) effect();
  return elements(tree);
}
function detail(nodes: ReturnType<typeof render>) {
  return nodes.find(node => node.type === CallJourneyCard || node.type === CallJourneySnapshotCard);
}
beforeEach(() => { harness.selected = null; harness.effects = []; harness.data = null; });

it("remembers the first available call after it ends and other calls arrive", () => {
  expect(detail(render([]))).toBeUndefined();
  expect(detail(render([call("first")]))?.props.journey).toMatchObject({ sessionId: "first" });
  expect(detail(render([call("second")]))?.props.id).toBe("first");
  expect(detail(render([]))?.props.id).toBe("first");
});
it("preserves explicit selection after the selected call leaves the list", () => {
  const nodes = render([call("first"), call("second")]);
  const buttons = nodes.filter(node => node.type === "button" && "aria-pressed" in node.props);
  (buttons[1].props.onClick as () => void)();
  expect(detail(render([call("first")]))?.props.id).toBe("second");
});
it("hides private call detail when the resource clears its data", () => {
  render([call("first")]);
  expect(detail(render(null))).toBeUndefined();
  expect(detail(render([]))?.props.id).toBe("first");
});
