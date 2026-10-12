import { describe, expect, it } from "vitest";
import { multiLineRoutingFixture, ids, extraIds } from "../../../../e2e/fixtures/incoming-routing-data";
import { lineProperties, lineWorkspaceChanges, workspaceChangesMatch } from "./line-workspace-model";
import { validateLineTransfers } from "@/lib/telephony/line-transfers";
import { parseIncomingFlow } from "@/lib/telephony/incoming-flow";
const flow = (lineId: string) => parseIncomingFlow({ version: 1, ending: "hangup", steps: [{ id: "00000000-0000-4000-8000-000000000999", type: "line", lineId }] });
describe("line workspace", () => {
  it("saves properties and routing together and verifies both after a lost response", () => {
    const document = structuredClone(multiLineRoutingFixture), line = document.lines.find(line => line.id === ids.line)!;
    const changes = lineWorkspaceChanges({ [line.id]: flow(extraIds.secondLine) }, { [line.id]: { ...lineProperties(line), label: " Odťahovka ", partnerName: " Allianz " } }, document);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ id: line.id, patch: { label: "Odťahovka", partnerName: "Allianz" } });
    expect(workspaceChangesMatch(changes, document)).toBe(false);
    line.incomingFlow = changes[0].flow;
    expect(workspaceChangesMatch(changes, document)).toBe(false);
    Object.assign(line, changes[0].patch);
    expect(workspaceChangesMatch(changes, document)).toBe(true);
  });
  it("allows metadata-only edits without replacing the saved route", () => {
    const document = structuredClone(multiLineRoutingFixture), line = document.lines[1];
    line.incomingFlow = flow(extraIds.secondLine);
    const changes = lineWorkspaceChanges({}, { [line.id]: { ...lineProperties(line), active: false } }, document);
    expect(changes[0]).toMatchObject({ flow: null, expectedFlow: line.incomingFlow, patch: { active: false } });
  });
  it("rejects a chain whose combined waiting time exceeds the call limit", () => {
    const document = structuredClone(multiLineRoutingFixture), first = document.lines[1], second = document.lines[2];
    first.incomingFlow = { version: 1, ending: "hangup", steps: [{ id: "00000000-0000-4000-8000-000000000997", type: "wait", minutes: 60 }, ...flow(second.id).steps] };
    second.incomingFlow = { version: 1, ending: "hangup", steps: [{ id: "00000000-0000-4000-8000-000000000996", type: "wait", minutes: 60 }, { id: "00000000-0000-4000-8000-000000000995", type: "wait", minutes: 1 }] };
    expect(validateLineTransfers(document).some(issue => issue.code === "line_route_too_long")).toBe(true);
  });
  it("rejects loops, inactive destinations and a transfer placed before another step", () => {
    const document = structuredClone(multiLineRoutingFixture), first = document.lines[1], second = document.lines[2];
    first.incomingFlow = flow(second.id);
    expect(validateLineTransfers(document)).toEqual([]);
    second.incomingFlow = flow(first.id);
    expect(validateLineTransfers(document).some(issue => issue.code === "line_loop")).toBe(true);
    second.incomingFlow = null; second.active = false;
    expect(validateLineTransfers(document).some(issue => issue.code === "line_unavailable")).toBe(true);
    expect(() => parseIncomingFlow({ ...flow(second.id), steps: [...flow(second.id).steps, { id: "00000000-0000-4000-8000-000000000998", type: "wait", minutes: 1 }] })).toThrow("posledný krok");
  });
});
