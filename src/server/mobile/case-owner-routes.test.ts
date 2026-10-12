import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/mobile/v1/cases/[id]/owner/route";
import { MutationError } from "@/server/mutation-error";
const mocks=vi.hoisted(()=>({actor:vi.fn(),get:vi.fn(),assign:vi.fn()}));
vi.mock("./auth",()=>({requireMobileActor:mocks.actor,mobileEnvironment:()=>"test"}));
vi.mock("./case-owner",async importOriginal=>({...await importOriginal<typeof import("./case-owner")>(),getMobileCaseOwner:mocks.get,assignMobileCaseOwner:mocks.assign}));
const id="40000000-0000-4000-8000-000000000001";
const actor={profileId:id,organizationId:"40000000-0000-4000-8000-000000000002",userId:id,displayName:"Jana",role:"dispatcher"};
const params={params:Promise.resolve({id})};
const input={ownerId:id,mutationId:id,expectedUpdatedAt:"2026-10-12T18:00:00.000001Z"};
const request=(body:unknown=input)=>new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/cases/"+id+"/owner",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();mocks.actor.mockResolvedValue(actor);mocks.get.mockResolvedValue({caseId:id,available:false,targets:[],capabilities:{take:false,assign:false}});mocks.assign.mockResolvedValue({caseId:id,mutationId:id,ownerId:id,committedRevision:input.expectedUpdatedAt,refreshRequired:true});});
describe("mobile owner routes",()=>{
  it.each([401,403,409,503])("auth denial%s precedes body/application reads",async status=>{
    mocks.actor.mockRejectedValue(new MutationError("Denied",status,"expected_organization_mismatch"));
    const malformed=new Request("https://test.invalid",{method:"POST",body:"{"});
    for(const handler of [GET,POST]){const response=await handler(malformed,params);expect(response.status).toBe(status);expect(response.headers.get("cache-control")).toBe("private, no-store");expect(response.headers.get("set-cookie")).toBeNull();if(status===401)expect(response.headers.get("www-authenticate")).toBe("Bearer");}
    expect(mocks.get).not.toHaveBeenCalled();expect(mocks.assign).not.toHaveBeenCalled();
  });
  it("returns private actor-derived scope and exact confirmed receipt",async()=>{
    for(const handler of [GET,POST]){const response=await handler(request(),params);expect(response.status).toBe(200);expect(response.headers.get("vary")).toContain("Authorization");expect(response.headers.get("cache-control")).toBe("private, no-store");expect(await response.json()).toMatchObject({profileId:actor.profileId,environment:"test",caseId:id});}
    expect(mocks.assign).toHaveBeenCalledWith(actor,id,input);
  });
  it("rejects malicious actor/owner clearing and too-large body after authorization",async()=>{
    for(const body of [{...input,actorId:id},{...input,ownerId:null},{...input,note:"x".repeat(64001)}])expect((await POST(request(body),params)).status).toBe(400);
    expect(mocks.assign).not.toHaveBeenCalled();
  });
  it("requires revision428 and hides internal errors without false success",async()=>{
    expect((await POST(request({ownerId:id,mutationId:id}),params)).status).toBe(428);
    mocks.assign.mockRejectedValue(new Error("private SQL"));const response=await POST(request(),params);expect(response.status).toBe(503);expect(JSON.stringify(await response.json())).not.toContain("private SQL");
  });
});
