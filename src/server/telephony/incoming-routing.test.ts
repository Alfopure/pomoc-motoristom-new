import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import { fakeError } from "@/test/fake-supabase";
import { getCoherentRoutingDocument, groupToInput, planToInput, parseIncomingLineModes, replaceIncomingRouting } from "./config-service";
const tables = { groups:"motorist_ring_groups",members:"motorist_ring_group_members",plans:"motorist_ring_plans",steps:"motorist_ring_plan_steps",hours:"motorist_business_hours",intervals:"motorist_business_hours_intervals",exceptions:"motorist_business_hours_exceptions",pauseReasons:"motorist_pause_reasons",presence:"motorist_operator_presence",lines:"motorist_telephony_lines",ivrMenus:"motorist_ivr_menus",ivrOptions:"motorist_ivr_options",profiles:"motorist_profiles",operatorSettings:"motorist_operator_telephony_settings",devices:"motorist_operator_devices" };
function fixture(atomicIncomingLineModes = true) {
  const h=createTelephonyHarness();
  for (const group of h.db.storage("motorist_ring_groups")) group.description ??= null;
  for (const plan of h.db.storage("motorist_ring_plans")) plan.fallback_number ??= null;
  for (const member of h.db.storage("motorist_ring_group_members")) { member.profile_id ??= null; member.external_number ??= null; member.ring_secs ??= null; }
  const snapshot=()=>JSON.parse(JSON.stringify({ ...Object.fromEntries(Object.entries(tables).map(([key,table])=>[key,h.rows(table)])), settings:h.rows("motorist_telephony_settings")[0],snapshotId:"test-snapshot", atomicIncomingLineModes }));
  h.db.registerRpc("motorist_routing_snapshot",()=>snapshot());
  h.db.registerRpc("motorist_save_incoming_routing",async(args,db)=>{
    const before=snapshot(); const result=await h.admin.rpc("motorist_replace_ring_plan",args as never); if(result.error) throw result.error;
    const document = args.p_document as { line_modes?: Array<{ id:string; inbound_call_mode:string|null }> };
    for (const change of document.line_modes ?? []) db.update("motorist_telephony_lines", { metadata: { ...(db.storage("motorist_telephony_lines").find(row => row.id === change.id)?.metadata as object), inbound_call_mode: change.inbound_call_mode } }, row => row.id === change.id);
    const after=snapshot();
    // A later commit may exist by the time the HTTP handler computes its audit.
    db.storage("motorist_ring_plans")[0].name="Later manager";
    return {before,after};
  });
  return h;
}
afterEach(()=>vi.unstubAllEnvs());
describe("incoming routing service",()=>{
  it.each(["true", "false"])("includes truthful mobile availability (%s) and inheritance in coherent manager reads", async flag => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", flag);
    const h = fixture();
    h.db.update("motorist_telephony_settings", { inbound_call_mode: "queue_first" }, () => true);
    const document = await getCoherentRoutingDocument(h.deps, { organizationId: ORG, includeSettings: false, includeLimits: true });
    expect(document.capabilities).toEqual({ ownedMobileRouting: flag === "true", defaultInboundCallMode: "queue_first", atomicIncomingLineModes: true, unifiedIncomingFlow: false });
    expect(document.settings).toBeNull();
    expect(h.db.log.filter(row => row.kind === "query")).toHaveLength(0);
  });
  it("withholds atomic line-mode capability on a database without the migration", async () => {
    const h = fixture(false);
    const document = await getCoherentRoutingDocument(h.deps, { organizationId: ORG, includeSettings: true });
    expect(document.capabilities?.atomicIncomingLineModes).toBe(false);
    await expect(replaceIncomingRouting(h.deps, { organizationId: ORG, actor: { profileId: PROFILES.o4, role: "manager" }, groups: document.groups.map(groupToInput), plans: document.plans.map(planToInput), lineModes: [{ id: document.lines[0].id, inboundCallMode: "queue_first", expectedInboundCallMode: null }], expectedVersion: 0 })).rejects.toMatchObject({ code: "config_migration_missing", status: 503 });
    expect(h.db.log.filter(row => row.kind === "rpc" && row.table === "motorist_save_incoming_routing")).toHaveLength(0);
  });
  it("includes line mode in the atomic payload, returned document and audit", async () => {
    const h = fixture();
    const document = await getCoherentRoutingDocument(h.deps, { organizationId: ORG, includeSettings: true });
    const result = await replaceIncomingRouting(h.deps, { organizationId: ORG, actor: { profileId: PROFILES.o4, role: "manager" }, groups: document.groups.map(groupToInput), plans: document.plans.map(planToInput), lineModes: [{ id: document.lines[0].id, inboundCallMode: "queue_first", expectedInboundCallMode: null }], expectedVersion: 0 });
    expect(result.document.lines[0].inboundCallMode).toBe("queue_first");
    expect(result.diff.changed).toEqual([{ id: `line:${document.lines[0].id}`, label: `Linka ${document.lines[0].label}`, fields: ["inboundCallMode"] }]);
    expect(h.rows("motorist_audit_log")[0].after_payload).toEqual(result.diff);
  });
  it("rejects a mode changed by the legacy line editor before calling the writer", async () => {
    const h = fixture();
    h.db.update("motorist_telephony_lines", { metadata: { inbound_call_mode: "ring_all" } }, () => true);
    const document = await getCoherentRoutingDocument(h.deps, { organizationId: ORG, includeSettings: true });
    await expect(replaceIncomingRouting(h.deps, { organizationId: ORG, actor: { profileId: PROFILES.o4, role: "manager" }, groups: document.groups.map(groupToInput), plans: document.plans.map(planToInput), lineModes: [{ id: document.lines[0].id, inboundCallMode: "queue_first", expectedInboundCallMode: null }], expectedVersion: 0 })).rejects.toMatchObject({ code: "config_conflict", status: 409 });
    expect(h.db.log.filter(row => row.kind === "rpc" && row.table === "motorist_save_incoming_routing")).toHaveLength(0);
  });
  it("maps concurrent SQL line conflict to a definite failed save", async () => {
    const h = fixture();
    h.db.registerRpc("motorist_save_incoming_routing", () => { throw fakeError("line_mode_conflict", "P0001"); });
    const document = await getCoherentRoutingDocument(h.deps, { organizationId: ORG, includeSettings: true });
    await expect(replaceIncomingRouting(h.deps, { organizationId: ORG, actor: { profileId: PROFILES.o4, role: "manager" }, groups: document.groups.map(groupToInput), plans: document.plans.map(planToInput), lineModes: [{ id: document.lines[0].id, inboundCallMode: "queue_first", expectedInboundCallMode: null }], expectedVersion: 0 })).rejects.toMatchObject({ code: "config_conflict", status: 409 });
    expect(h.rows("motorist_audit_log")).toHaveLength(0);
  });
  it("does not fall back to unrelated multi-query reads when coherent RPC missing",async()=>{
    const h=createTelephonyHarness();h.db.registerRpc("motorist_routing_snapshot",()=>{throw fakeError("Could not find the function","PGRST202");});
    await expect(getCoherentRoutingDocument(h.deps,{organizationId:ORG,includeSettings:true})).rejects.toMatchObject({code:"config_snapshot_missing",status:503});
    expect(h.db.log.filter(row=>row.kind==="query")).toHaveLength(0);
  });
  it("audits exactly this commit, including both sections, not a later reread",async()=>{
    const h=fixture();const document=await getCoherentRoutingDocument(h.deps,{organizationId:ORG,includeSettings:true});
    const groups=document.groups.map(groupToInput);const plans=document.plans.map(planToInput);groups[0].name="My group";plans[0].name="My plan";
    const result=await replaceIncomingRouting(h.deps,{organizationId:ORG,actor:{profileId:PROFILES.o4,role:"manager"},groups,plans,expectedVersion:document.routingVersion});
    expect(result.document.plans[0].name).toBe("My plan");expect(JSON.stringify(result.diff)).not.toContain("Later manager");
    expect(result.diff.changed).toHaveLength(2);expect(result.diff.changed).toEqual(expect.arrayContaining([{ id: expect.stringContaining("group:"), label: "Skupina My group", fields: ["name"] }, { id: expect.stringContaining("plan:"), label: "Plán My plan", fields: ["name"] }]));const audit=h.rows("motorist_audit_log")[0];expect(audit.actor_profile_id).toBe(PROFILES.o4);expect(audit.action).toBe("telephony.incoming_routing.replace");
  });
  it("enforces personal-owner feature gate in the combined path",async()=>{
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED","false");const h=fixture();const document=await getCoherentRoutingDocument(h.deps,{organizationId:ORG,includeSettings:true});
    const groups=document.groups.map(groupToInput);const member=groups.flatMap(group=>group.members).find(member=>member.memberKind==="external_number")!;member.ownerProfileId=PROFILES.o1;
    await expect(replaceIncomingRouting(h.deps,{organizationId:ORG,actor:{profileId:PROFILES.o4,role:"manager"},groups,plans:document.plans.map(planToInput),expectedVersion:0})).rejects.toMatchObject({code:"stability_disabled"});
  });
});


describe("incoming line-mode payload", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  it("supports omitted changes and explicit inherited mode", () => {
    expect(parseIncomingLineModes(undefined)).toEqual([]);
    expect(parseIncomingLineModes([{ id, inboundCallMode: null, expectedInboundCallMode: "ring_first" }])).toEqual([{ id, inboundCallMode: null, expectedInboundCallMode: "ring_first" }]);
  });
  it.each([null, {}, [null], [{ id }], [{ id, inboundCallMode: "ring_all" }], [{ id, inboundCallMode: "ring_all", expectedInboundCallMode: "bogus" }], [{ id, inboundCallMode: false, expectedInboundCallMode: null }], [{ id, inboundCallMode: null, expectedInboundCallMode: null, active: false }], [{ id: "wrong", inboundCallMode: null, expectedInboundCallMode: null }]])("rejects malformed or unsupported fields %#", value => {
    expect(() => parseIncomingLineModes(value)).toThrow();
  });
  it("rejects duplicate line IDs and excessive changes", () => {
    const change = { id, inboundCallMode: null, expectedInboundCallMode: null };
    expect(() => parseIncomingLineModes([change, change])).toThrow();
    expect(() => parseIncomingLineModes(Array.from({ length: 201 }, () => change))).toThrow();
  });
});

it("old combined mode editor cannot override an active step flow", async () => {
  const h = fixture();
  const lineId = String(h.rows("motorist_telephony_lines")[0].id);
  h.db.update("motorist_telephony_lines", { metadata: { incoming_flow: { version: 1, ending: "hangup", steps: [{ id: "00000000-0000-4000-8000-000000000099", type: "wait", minutes: 1 }] } } }, row => row.id === lineId);
  const document = await getCoherentRoutingDocument(h.deps, { organizationId: ORG, includeSettings: true });
  await expect(replaceIncomingRouting(h.deps, { organizationId: ORG, actor: { profileId: PROFILES.o1, role: "admin" }, expectedVersion: document.routingVersion, groups: document.groups.map(groupToInput), plans: document.plans.map(planToInput), lineModes: [{ id: lineId, inboundCallMode: "ring_all", expectedInboundCallMode: null }] })).rejects.toMatchObject({ code: "incoming_flow_active" });
  expect(h.db.log.some(row => row.kind === "rpc" && row.table === "motorist_save_incoming_routing")).toBe(false);
});
