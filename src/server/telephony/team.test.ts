import { beforeEach, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
const stats = vi.hoisted(() => vi.fn());
vi.mock("./stats", () => ({ loadTelephonyStatsCached: stats }));
import { loadTelephonyTeam } from "./team";
const NOW = new Date("2026-09-20T05:30:00Z");
beforeEach(() => { stats.mockReset(); stats.mockResolvedValue({ operators: [] }); });
it("includes offline colleagues and exposes no device identifiers or manager aggregates", async () => {
  const fake = createFakeSupabase();
  fake.db.seed("motorist_profiles", [
    {id:"one",organization_id:"org",display_name:"Jana",active:true,access_status:"active"},
    {id:"offline",organization_id:"org",display_name:"Peter",active:true,access_status:"active"},
    {id:"foreign",organization_id:"other",display_name:"Other",active:true,access_status:"active"},
  ]);
  fake.db.seed("motorist_operator_devices", [{profile_id:"one",organization_id:"org",environment:"production",registration_state:"registered",device_seen_at:NOW.toISOString(),metadata:{unrelated:"secret"},sip_username:"secret",telnyx_credential_id:"secret"}]);
  fake.db.seed("motorist_call_sessions", [{id:"session",organization_id:"org",state:"talking",answered_by_profile_id:"one",caller_number:"+421900000000",metadata:{secret:"never"}}]);
  stats.mockResolvedValue({ operators: [{profileId:"one",state:"on_call",since:"2026-09-19T12:00:00Z",answeredToday:4,talkSecondsToday:100}], today: { secret:"report" }, callbacks:{open:20} });
  const payload = await loadTelephonyTeam({admin:fake.admin,organizationId:"org",environment:"production",now:()=>NOW});
  expect(payload.operators).toHaveLength(2);
  expect(payload.operators.find(x=>x.profileId==="offline")).toMatchObject({status:"offline",answeredToday:0,lastDeviceContactAt:null,online:false,lastOnlineAt:null});
  expect(payload.operators.find(x=>x.profileId==="one")).toMatchObject({status:"on_call",answeredToday:4,call:{sessionId:"session"},online:true,lastOnlineAt:NOW.toISOString()});
  expect(JSON.stringify(payload)).not.toContain("secret");
  expect(payload).not.toHaveProperty("today"); expect(payload).not.toHaveProperty("callbacks");
  expect(fake.db.log.every(row=>row.filters?.includes("eq(organization_id)"))).toBe(true);
});

it("derives last online from verified web or mobile contact in this environment, independently of queue availability", async () => {
  const fake = createFakeSupabase();
  const profiles = ["fresh", "stale", "left", "mobile", "dev-only", "registering", "bad-metadata", "future"];
  fake.db.seed("motorist_profiles", profiles.map(id => ({id,organization_id:"org",display_name:id,active:true,access_status:"active"})));
  const past = "2026-09-20T05:00:00.000Z";
  const older = "2026-09-19T12:00:00.000Z";
  const base = {organization_id:"org",environment:"production",registration_state:"registered",device_seen_at:NOW.toISOString(),metadata:{}};
  fake.db.seed("motorist_operator_devices", [
    {...base,profile_id:"fresh"},
    {...base,profile_id:"stale",device_seen_at:past},
    {...base,profile_id:"left",device_seen_at:null,registration_state:"unregistered",metadata:{last_online_at:past}},
    {...base,profile_id:"mobile",device_seen_at:null,registration_state:"unregistered",metadata:{last_online_at:older}},
    {...base,profile_id:"dev-only",environment:"development",metadata:{last_online_at:NOW.toISOString()}},
    {...base,profile_id:"registering",registration_state:"registering",metadata:{last_online_at:older}},
    {...base,profile_id:"bad-metadata",registration_state:"unregistered",device_seen_at:null,metadata:{last_online_at:"not-a-date"}},
    {...base,profile_id:"future",device_seen_at:"2099-01-01T00:00:00Z",metadata:{last_online_at:"2099-01-01T00:00:00Z"}},
    {...base,profile_id:"stale",environment:"development"},
    {...base,profile_id:"left",organization_id:"another-org"},
  ]);
  fake.db.seed("motorist_operator_mobile_devices", [{...base,profile_id:"mobile"}]);
  stats.mockResolvedValue({operators:[{profileId:"fresh",state:"paused"},{profileId:"left",state:"available"}]});
  const payload = await loadTelephonyTeam({admin:fake.admin,organizationId:"org",environment:"production",now:()=>NOW});
  const byId = Object.fromEntries(payload.operators.map(operator => [operator.profileId,operator]));
  expect(byId.fresh).toMatchObject({status:"paused",online:true,lastOnlineAt:NOW.toISOString()});
  expect(byId.stale).toMatchObject({online:false,lastOnlineAt:past});
  expect(byId.left).toMatchObject({status:"available",online:false,lastOnlineAt:past,lastDeviceContactAt:past});
  expect(byId.mobile).toMatchObject({online:true,lastOnlineAt:NOW.toISOString(),lastDeviceContactAt:older,lastMobileContactAt:NOW.toISOString()});
  expect(byId["dev-only"]).toMatchObject({online:false,lastOnlineAt:null});
  expect(byId.registering).toMatchObject({online:false,lastOnlineAt:older});
  expect(byId["bad-metadata"]).toMatchObject({online:false,lastOnlineAt:null});
  expect(byId.future).toMatchObject({online:false,lastOnlineAt:null});
  expect(fake.db.log.filter(row=>row.table.includes("operator_devices")||row.table.includes("mobile_devices")).every(row=>row.filters?.includes("eq(environment)"))).toBe(true);
});

it("keeps newer retained history when liveness is older or absent and excludes revoked profiles", async () => {
  const fake = createFakeSupabase();
  fake.db.seed("motorist_profiles", [
    {id:"one",organization_id:"org",display_name:"One",active:true,access_status:"active"},
    {id:"blocked",organization_id:"org",display_name:"Blocked",active:true,access_status:"blocked"},
    {id:"inactive",organization_id:"org",display_name:"Inactive",active:false,access_status:"active"},
  ]);
  fake.db.seed("motorist_operator_devices", [{profile_id:"one",organization_id:"org",environment:"development",registration_state:"registered",device_seen_at:"2026-09-19T12:00:00Z",metadata:{last_online_at:"2026-09-20T05:00:00Z"}}]);
  fake.db.seed("motorist_operator_mobile_devices", [{profile_id:"one",organization_id:"org",environment:"development",registration_state:"unregistered",device_seen_at:null,metadata:{last_online_at:"2026-09-20T05:15:00Z"}}]);
  const payload = await loadTelephonyTeam({admin:fake.admin,organizationId:"org",environment:"development",now:()=>NOW});
  expect(payload.operators).toHaveLength(1);
  expect(payload.operators[0]).toMatchObject({online:false,lastOnlineAt:"2026-09-20T05:15:00.000Z",lastDeviceContactAt:"2026-09-20T05:00:00.000Z"});
});

it("recognizes a legitimate heartbeat received during the asynchronous reads", async () => {
  const fake = createFakeSupabase();
  let clock = NOW;
  const heartbeatAt = new Date(NOW.getTime()+50).toISOString();
  fake.db.seed("motorist_profiles",[{id:"one",organization_id:"org",display_name:"One",active:true,access_status:"active"}]);
  fake.db.seed("motorist_operator_devices",[{profile_id:"one",organization_id:"org",environment:"production",registration_state:"registered",device_seen_at:heartbeatAt,metadata:{last_online_at:heartbeatAt}}]);
  stats.mockImplementationOnce(async () => {
    await Promise.resolve();
    clock = new Date(NOW.getTime()+100);
    return {operators:[]};
  });
  const payload = await loadTelephonyTeam({admin:fake.admin,organizationId:"org",environment:"production",now:()=>clock});
  expect(payload.checkedAt).toBe(NOW.toISOString());
  expect(payload.operators[0]).toMatchObject({online:true,lastOnlineAt:heartbeatAt});
});
