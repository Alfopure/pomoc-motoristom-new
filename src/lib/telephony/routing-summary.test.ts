import { describe, expect, it } from "vitest";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import { getRoutingDocument } from "@/server/telephony/config-service";
import type { IncomingFlow } from "./incoming-flow";
import { buildRoutingSummary } from "./routing-summary";
const at = new Date("2026-09-03T08:00:00Z");
async function document() { const harness = createTelephonyHarness({ ivrOnNeutralLine: false }); return getRoutingDocument(harness.deps, { organizationId: ORG, includeSettings: true }); }
const flow: IncomingFlow = { version: 1, ending: "hangup", steps: [
  { id: "ring", type: "ring", seconds: 20, people: [{ profileId: PROFILES.o1, application: true, personalNumber: "+421910988882" }] },
  { id: "wait", type: "wait", minutes: 15 },
  { id: "repeat", type: "repeat", stepIds: ["ring"], times: 2 },
  { id: "external", type: "external", number: "+421911222333", seconds: 30 },
] };
describe("operational routing summary", () => {
  it("does not serialize raw settings, devices, SIP IDs or allowlists", async () => {
    const source = await document(); const body = JSON.stringify(buildRoutingSummary(source, at, false));
    for (const field of ["credentialId", "sipUsername", "destinationAllowlist", "dailyLegSoftCap", "smsLiveSends", "operatorSettings"]) expect(body).not.toContain(field);
    expect(buildRoutingSummary(source, at, false).canEdit).toBe(false);
  });
  it("describes effective return line rather than the return number's own plan", async () => {
    const source = await document(); source.lines[0].returnLineId = source.lines[1].id; source.lines[0].ringPlanId = null;
    const line = buildRoutingSummary(source, at, true).lines[0];
    expect(line.effectiveLineLabel).toBe(source.lines[1].label); expect(line.target.planId).toBe(source.lines[1].ringPlanId); expect(line.sentence).toContain("Dispečing A");
  });
  it("rejects a return line whose only group members are inactive", async () => {
    const source = await document(); source.lines[0].returnLineId = source.lines[1].id;
    source.operators.forEach(operator => { operator.active = false; });
    source.groups.forEach(group => { group.members.forEach(member => { member.externalNumber = null; }); });
    expect(buildRoutingSummary(source, at, true).lines[0].status).toBe("unavailable");
  });
  it("keeps invalid return routing unknown, not a invented live step", async () => {
    const source = await document(); source.lines[0].returnLineId = "missing";
    expect(buildRoutingSummary(source, at, true).lines[0].status).toBe("unavailable");
  });
  it("honors closing boundary, holidays and disabled schedule as nonstop", async () => {
    const source = await document();
    expect(buildRoutingSummary(source, new Date("2026-09-03T10:00:00Z"), false).lines[0].status).toBe("closed");
    expect(buildRoutingSummary(source, new Date("2026-12-24T08:00:00Z"), false).lines[0].notes.join()).toContain("Štedrý deň");
    source.businessHours[0].active = false;
    expect(buildRoutingSummary(source, new Date("2026-12-24T08:00:00Z"), false).lines[0].status).toBe("open");
  });
  it("explains fanout and availability without predicting pickup", async () => {
    const source = await document(); source.limits!.maxRingFanout = 1;
    const line = buildRoutingSummary(source, at, false).lines[0];
    expect(line.sentence).toContain("najviac 1"); expect(line.notes.join()).toContain("iba dostupných");
  });
  it("shows callback instead of configured fallback when plan cannot start", async () => {
    const source = await document(); source.plans[0].active = false; source.plans[0].fallbackKind = "external_number"; source.plans[0].fallbackNumber = "+421900000000";
    const sentence = buildRoutingSummary(source, at, true).lines[0].sentence;
    expect(sentence).toContain("ponuku spätného volania"); expect(sentence).not.toContain("+421900000000");
  });
  it("describes every IVR branch and inactive target falls back to line plan", async () => {
    const source = await document(); source.lines[0].ivrMenuId = source.ivrMenus[0].id;
    source.ivrMenus[0].options = ["ring_plan", "callback", "external_number", "waiting_room", "repeat", "hangup"].map((action, index) => ({ id: String(index), digit: String(index), action: action as "ring_plan", targetRingPlanId: "missing", targetNumber: "+421900000000", label: action, promptMediaUrl: null, ttsText: null }));
    const line = buildRoutingSummary(source, at, true).lines[0];
    expect(line.branches).toHaveLength(7); expect(line.branches[0].sentence).toContain("použije sa plán linky"); expect(line.branches[6].label).toBe("Bez platnej voľby");
    expect(line.target.lineId).toBe(source.lines[0].id);
  });
  it("marks a disabled runtime gate without exposing raw admin fields", async () => {
    const source = await document(); const summary = buildRoutingSummary(source, at, false, { liveCallsEnabled: false });
    expect(summary.lines[0].sentence).toContain("Živé volanie nie je povolené"); expect(summary.snapshotId).toContain(":paused"); expect(JSON.stringify(summary)).not.toContain("liveCallsEnabled");
  });
  it("does not present assumed settings as verified data", async () => {
    const source = await document(); source.settingsConfigured = false;
    const notes = buildRoutingSummary(source, at, false).lines[0].notes.join();
    expect(notes).toContain("zatiaľ nie sú overené"); expect(notes).not.toContain("limit 30 min");
  });

  it("describes a saved mixed flow instead of its ignored legacy plan, mode or queue fallback", async () => {
    const source = await document();
    source.lines[0].incomingFlow = flow;
    source.lines[0].inboundCallMode = "queue_first";
    source.plans[0].active = false;
    source.plans[0].fallbackKind = "external_number";
    source.plans[0].fallbackNumber = "+421999999999";
    const line = buildRoutingSummary(source, at, true).lines[0];
    expect(line.status).toBe("open");
    expect(line.sentence).toContain("Jana Dispečerka (najviac 20 s) → čakáreň najviac 15 min → kroky 1 ešte 2× → +421911222333 (najviac 30 s) → ukončenie hovoru");
    expect(line.branches.map(branch => branch.label)).toEqual(["1. Zvonenie", "2. Čakáreň", "3. Opakovanie", "4. Záložné číslo", "Ak nikto neprevezme hovor"]);
    expect(line.branches[0].sentence).toContain("aplikácia – web a mobilná appka + osobné číslo +421910988882");
    expect(line.branches[1].sentence).toContain("ručné prevzatie");
    expect(line.branches[2].sentence).toContain("v tomto poradí, ešte 2×");
    expect(line.branches[4].sentence).toBe("Hovor sa ukončí.");
    expect(line.target).not.toHaveProperty("planId");
    expect(line.branches.every(branch => branch.target.lineId === source.lines[0].id && !branch.target.planId && branch.navigationLabel === "Nastavenie postupu")).toBe(true);
    const serialized = JSON.stringify(line);
    for (const misleading of ["+421999999999", "Dispečing A", "limit 30 min", "120 s nepretržitej", "Eskalácia čakárne"]) expect(serialized).not.toContain(misleading);
    expect(line.notes.join()).toContain("ďalšie kroky sa zastavia");
  });

  it("retains business-hours decisions and navigation before the flow", async () => {
    const source = await document(); source.lines[0].incomingFlow = flow;
    const open = buildRoutingSummary(source, at, true).lines[0];
    expect(open.timezone).toBe(source.businessHours[0].timezone);
    const closed = buildRoutingSummary(source, new Date("2026-09-03T10:00:00Z"), true).lines[0];
    expect(closed.status).toBe("closed");
    expect(closed.sentence).toContain("kontrole otváracích hodín");
    expect(closed.branches).toEqual([]);
    expect(closed.target).toMatchObject({ tab: "hours", businessHoursId: source.lines[0].businessHoursId });
    const holiday = buildRoutingSummary(source, new Date("2026-12-24T08:00:00Z"), false).lines[0];
    expect(holiday.notes.join()).toContain("Štedrý deň");
  });

  it("does not advertise legacy routing when a saved flow is invalid", async () => {
    const source = await document(); source.lines[0].incomingFlowInvalid = true;
    const line = buildRoutingSummary(source, at, true).lines[0];
    expect(line.status).toBe("unavailable");
    expect(line.sentence).toContain("nepodarilo bezpečne načítať");
    expect(line.sentence).not.toContain("Dispečing A");
    expect(line.branches).toEqual([]);
    expect(line.target).not.toHaveProperty("planId");
  });

  it("distinguishes the two other flow endings and does not invent queue limits", async () => {
    const source = await document(); source.settingsConfigured = false;
    source.lines[0].incomingFlow = { ...flow, ending: "hangup_message" };
    expect(buildRoutingSummary(source, at, false).lines[0].branches.at(-1)?.sentence).toContain("záverečná hláška");
    source.lines[0].incomingFlow = { ...flow, ending: "callback_prompt" };
    const line = buildRoutingSummary(source, at, false).lines[0];
    expect(line.branches.at(-1)?.sentence).toContain("číslo volajúceho nie je použiteľné");
    expect(line.notes.join()).toContain("limity súbežného zvonenia zatiaľ nie sú overené");
    expect(line.notes.join()).not.toContain("limity čakárne");
  });
});
