import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RoutingDocument } from "@/server/telephony/config-service";
import type { IncomingFlow } from "@/lib/telephony/incoming-flow";
import { IncomingFlowSteps, WaitingRoomPolicy } from "./IncomingFlowSteps";

describe("incoming flow presentation", () => {
  it("places the add-step action before the final fallback", () => {
    const flow: IncomingFlow = { version: 1, steps: [{ id: "wait", type: "wait", minutes: 5 }], ending: "callback_prompt" };
    const html = renderToStaticMarkup(createElement(IncomingFlowSteps, { flow, document: { operators: [] } as unknown as RoutingDocument, lineId: "line", disabled: false, onChange() {}, rememberedNumbers: {}, rememberNumber() {} }));
    expect(html.indexOf("Pridať ďalší krok")).toBeLessThan(html.indexOf("Až na konci:"));
  });
  it("truthfully shows the retained callback-and-60s behavior on legacy waits", () => {
    const html = renderToStaticMarkup(createElement(WaitingRoomPolicy, { step: { id: "wait", type: "wait", minutes: 5 }, disabled: false, onChange() {} }));
    expect(html).toContain("Hudba medzi hláškami");
    expect(html).toContain("Stlačenie 1 potvrdí požiadavku");
    expect(html).toMatch(/aria-pressed="true"[^>]*>60 s/);
  });
  it("does not offer an interval or hidden callback in music-only mode", () => {
    const html = renderToStaticMarkup(createElement(WaitingRoomPolicy, { step: { id: "wait", type: "wait", minutes: 5, policy: { mode: "music", intervalSeconds: 30 } }, disabled: false, onChange() {} }));
    expect(html).toContain("Hrá iba hudba.");
    expect(html).not.toContain("Hudba medzi hláškami");
    expect(html).not.toContain("Stlačenie 1 potvrdí");
  });
});
