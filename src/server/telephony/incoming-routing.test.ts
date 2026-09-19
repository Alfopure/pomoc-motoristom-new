import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import { fakeError } from "@/test/fake-supabase";
import { getCoherentRoutingDocument, groupToInput, planToInput, replaceIncomingRouting } from "./config-service";
const tables = { groups:"motorist_ring_groups",members:"motorist_ring_group_members",plans:"motorist_ring_plans",steps:"motorist_ring_plan_steps",hours:"motorist_business_hours",intervals:"motorist_business_hours_intervals",exceptions:"motorist_business_hours_exceptions",pauseReasons:"motorist_pause_reasons",presence:"motorist_operator_presence",lines:"motorist_telephony_lines",ivrMenus:"motorist_ivr_menus",ivrOptions:"motorist_ivr_options",profiles:"motorist_profiles",operatorSettings:"motorist_operator_telephony_settings",devices:"motorist_operator_devices" };
function fixture() {
  const h=createTelephonyHarness();
  for (const group of h.db.storage("motorist_ring_groups")) group.description ??= null;
  for (const plan of h.db.storage("motorist_ring_plans")) plan.fallback_number ??= null;
  for (const member of h.db.storage("motorist_ring_group_members")) { member.profile_id ??= null; member.external_number ??= null; member.ring_secs ??= null; }
  const snapshot=()=>JSON.parse(JSON.stringify({ ...Object.fromEntries(Object.entries(tables).map(([key,table])=>[key,h.rows(table)])), settings:h.rows("motorist_telephony_settings")[0],snapshotId:"test-snapshot" }));
  h.db.registerRpc("motorist_routing_snapshot",()=>snapshot());
  h.db.registerRpc("motorist_save_incoming_routing",async(args,db)=>{
    const before=snapshot(); const result=await h.admin.rpc("motorist_replace_ring_plan",args as never); if(result.error) throw result.error;
    const after=snapshot();
    // A later commit may exist by the time the HTTP handler computes its audit.
    db.storage("motorist_ring_plans")[0].name="Later manager";
    return {before,after};
  });
  return h;
}
afterEach(()=>vi.unstubAllEnvs());
describe("incoming routing service",()=>{
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
