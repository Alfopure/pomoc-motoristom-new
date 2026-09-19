import { expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
const stats = vi.hoisted(() => vi.fn());
vi.mock("./stats", () => ({ loadTelephonyStatsCached: stats }));
import { loadTelephonyTeam } from "./team";
it("includes offline colleagues and exposes no device identifiers or manager aggregates", async () => {
  const fake = createFakeSupabase();
  fake.db.seed("motorist_profiles", [
    {id:"one",organization_id:"org",display_name:"Jana",active:true,access_status:"active"},
    {id:"offline",organization_id:"org",display_name:"Peter",active:true,access_status:"active"},
    {id:"foreign",organization_id:"other",display_name:"Other",active:true,access_status:"active"},
  ]);
  fake.db.seed("motorist_operator_devices", [{profile_id:"one",organization_id:"org",device_seen_at:"2026-09-19T12:00:00Z",sip_username:"secret",telnyx_credential_id:"secret"}]);
  fake.db.seed("motorist_call_sessions", [{id:"session",organization_id:"org",state:"talking",answered_by_profile_id:"one",caller_number:"+421900000000",metadata:{secret:"never"}}]);
  stats.mockResolvedValue({ operators: [{profileId:"one",state:"on_call",since:"2026-09-19T12:00:00Z",answeredToday:4,talkSecondsToday:100}], today: { secret:"report" }, callbacks:{open:20} });
  const payload = await loadTelephonyTeam({admin:fake.admin,organizationId:"org"});
  expect(payload.operators).toHaveLength(2);
  expect(payload.operators.find(x=>x.profileId==="offline")).toMatchObject({status:"offline",answeredToday:0,lastDeviceContactAt:null});
  expect(payload.operators.find(x=>x.profileId==="one")).toMatchObject({status:"on_call",answeredToday:4,call:{sessionId:"session"}});
  expect(JSON.stringify(payload)).not.toContain("secret");
  expect(payload).not.toHaveProperty("today"); expect(payload).not.toHaveProperty("callbacks");
  expect(fake.db.log.every(row=>row.filters?.includes("eq(organization_id)"))).toBe(true);
});
