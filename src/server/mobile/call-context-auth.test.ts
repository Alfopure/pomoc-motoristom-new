import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
const mocks=vi.hoisted(()=>({claims:vi.fn(),admin:vi.fn(),organization:vi.fn(),read:vi.fn()}));
vi.mock("@supabase/supabase-js",()=>({createClient:()=>({auth:{getClaims:mocks.claims}})}));
vi.mock("@/lib/supabase/admin",()=>({createSupabaseAdminClient:mocks.admin}));
vi.mock("@/server/default-organization",()=>({resolveDefaultOrganizationId:mocks.organization}));
vi.mock("./call-context",async original=>({...await original<typeof import("./call-context")>(),getMobileCallContext:mocks.read}));
import * as route from "@/app/api/mobile/v1/calls/[id]/context/route";
const userId="11111111-1111-4111-8111-111111111111",profileId="22222222-2222-4222-8222-222222222222",organizationId="33333333-3333-4333-8333-333333333333",callId="AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const issuer="https://nzpnqdstvkfncflgqlny.supabase.co/auth/v1";
const claims=()=>({sub:userId,iss:issuer,aud:"authenticated",role:"authenticated",exp:Math.floor(Date.now()/1000)+3600});
const token=Buffer.from(JSON.stringify({alg:"ES256"})).toString("base64url")+"."+Buffer.from(JSON.stringify(claims())).toString("base64url")+".signature";
let db:ReturnType<typeof createFakeSupabase>;
function request(query="source=call",headers:Record<string,string>={}) {return new Request(`https://test.dispecing.linkapomoci.sk/api/mobile/v1/calls/${callId}/context?${query}`,{headers:{Authorization:"Bearer "+token,"X-PM-App-Environment":"test","X-PM-Expected-Organization":organizationId,...headers}});}
const invoke=(req=request(),id=callId)=>route.GET(req,{params:Promise.resolve({id})});
function privateResponse(response:Response){expect(response.headers.get("Cache-Control")).toBe("private, no-store");expect(response.headers.get("Vary")).toBe("Authorization, X-PM-App-Environment");expect(response.headers.get("Set-Cookie")).toBeNull();}
beforeEach(()=>{
 vi.resetAllMocks();for(const[k,v]of Object.entries({MOTORIST_APP_ENV:"test",VERCEL_ENV:"production",VERCEL_PROJECT_ID:"prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk",SUPABASE_URL:issuer.replace("/auth/v1",""),SUPABASE_PUBLISHABLE_KEY:"fixture"}))vi.stubEnv(k,v);
 vi.stubGlobal("fetch",vi.fn(()=>{throw new Error("Unexpected network");}));mocks.claims.mockResolvedValue({data:{claims:claims()},error:null});mocks.organization.mockResolvedValue(organizationId);db=createFakeSupabase();db.db.seed("motorist_profiles",[{id:profileId,user_id:userId,organization_id:organizationId,display_name:"Dispatcher",role:"dispatcher",active:true,access_status:"active",kind:"human"}]);mocks.admin.mockReturnValue(db.client);
 mocks.read.mockImplementation(async(_actor,target)=>({target,call:{id:callId.toLowerCase(),sessionId:null,direction:"inbound",status:"ended",number:null,name:null,lineLabel:null,operatorName:null,startedAt:"2026-10-15T19:00:00Z",answeredAt:null,endedAt:null,durationSeconds:null},linkedCase:null,linkState:"unlinked"}));
});
afterEach(()=>{expect(fetch).not.toHaveBeenCalled();vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe("call context actual Bearer auth boundary",()=>{
 it.each(["","Bearer invalid"])("auth precedes source/id validation and ignores cookies %s",async authorization=>{const response=await invoke(request("bad=1",{authorization,Cookie:"session=fake"}),"bad");expect(response.status).toBe(401);privateResponse(response);expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");expect(mocks.admin).not.toHaveBeenCalled();expect(mocks.read).not.toHaveBeenCalled();});
 it("rejects unverifiable JWT",async()=>{mocks.claims.mockResolvedValue({data:null,error:new Error("private-auth-error")});expect((await invoke()).status).toBe(401);expect(mocks.read).not.toHaveBeenCalled();});
 it.each<Record<string,string>>([{"X-PM-App-Environment":"production"},{"X-PM-Expected-Organization":userId}])("rejects changed scope %j",async headers=>{const response=await invoke(request("source=call",headers));expect(response.status).toBe(409);privateResponse(response);expect(mocks.read).not.toHaveBeenCalled();});
 it("requires expected organization before reading",async()=>{const req=request();req.headers.delete("X-PM-Expected-Organization");expect((await invoke(req)).status).toBe(409);expect(mocks.read).not.toHaveBeenCalled();});
 it("rejects malformed organization",async()=>{expect((await invoke(request("source=call",{"X-PM-Expected-Organization":"bad"}))).status).toBe(400);expect(mocks.read).not.toHaveBeenCalled();});
 it.each([{active:false},{kind:"ai"},{role:"driver"},{organization_id:userId}])("rejects unauthorized profile %j",async patch=>{db.db.update("motorist_profiles",patch,r=>r.id===profileId);expect((await invoke()).status).toBe(403);expect(mocks.read).not.toHaveBeenCalled();});
 it.each(["dispatcher","senior_dispatcher","manager","admin"])("allows exact history role %s",async role=>{db.db.update("motorist_profiles",{role},r=>r.id===profileId);const response=await invoke();expect(response.status).toBe(200);privateResponse(response);expect(await response.json()).toMatchObject({ok:true,apiVersion:1,profileId,organizationId,environment:"test",target:{kind:"call",id:callId.toLowerCase()}});expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({profileId,organizationId}),{kind:"call",id:callId.toLowerCase()},expect.any(AbortSignal));});
 it.each(["source=call&source=session","source=call&other=1","source=invalid",""])("rejects invalid query %s after auth",async query=>{expect((await invoke(request(query))).status).toBe(400);expect(mocks.read).not.toHaveBeenCalled();});
 it("session selector stays explicit",async()=>{expect((await invoke(request("source=session"))).status).toBe(200);expect(mocks.read.mock.calls[0][1]).toEqual({kind:"session",id:callId.toLowerCase()});});
 it("sanitizes private read failure",async()=>{mocks.read.mockRejectedValue(new Error("private-db-secret"));const response=await invoke();expect(response.status).toBe(503);privateResponse(response);expect(await response.text()).not.toContain("private-db-secret");});
 it("exposes no mutation handlers",()=>{expect(Object.keys(route).sort()).toEqual(["GET","runtime"]);});
});
