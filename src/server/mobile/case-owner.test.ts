import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { caseMutationIdentity } from "@/server/case-atomic-save";
import { assignMobileCaseOwner, getMobileCaseOwner, parseMobileCaseOwner } from "./case-owner";
const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = { userId: id(1), profileId: id(2), organizationId: id(3), role: "dispatcher" as const, displayName: "Jana" };
const revision = "2026-10-12T18:00:00.000001Z";
const input = { mutationId: id(9), expectedUpdatedAt: revision, ownerId: id(4) };
function fixture(owner: string | null = null, status = "open") {
  const f = createFakeSupabase(); mocks.admin.mockReturnValue(f.admin);
  f.db.seed("motorist_cases", [{ id: id(5), organization_id: actor.organizationId, owner_id: owner, status, updated_at: revision }]);
  f.db.seed("motorist_profiles", [actor.profileId, id(4)].map((key, n) => ({ id: key, user_id: n ? id(51) : actor.userId, organization_id: actor.organizationId, display_name: n ? "Peter" : "Jana", role: "dispatcher", active: true, access_status: "active", kind: "human" })));
  f.db.registerRpc("motorist_case_owner_version", () => 1);
  return f;
}
beforeEach(() => vi.clearAllMocks());
describe("mobile owner commands", () => {
  it("requires revision and strict original identity; never accepts clearing or actor input", () => {
    expect(() => parseMobileCaseOwner({ mutationId: id(9), ownerId: id(4) })).toThrow(expect.objectContaining({ status: 428 }));
    for (const value of [null, [], {...input, actorId: id(2)}, {...input, ownerId: null}, {...input, mutationId: "bad"}, {...input, expectedUpdatedAt: "2026-02-30T00:00:00Z"}]) expect(() => parseMobileCaseOwner(value)).toThrow();
    expect(parseMobileCaseOwner(input)).toEqual(input);
  });
  it("returns only active eligible org targets and take only for unassigned nonterminal", async () => {
    const f = fixture();
    f.db.seed("motorist_profiles", [
      { id: id(11), organization_id: id(80), active: true, access_status: "active", kind: "human", role: "dispatcher" },
      { id: id(12), organization_id: actor.organizationId, active: false, access_status: "active", kind: "human", role: "dispatcher" },
      { id: id(13), organization_id: actor.organizationId, active: true, access_status: "invited", kind: "human", role: "dispatcher" },
      { id: id(14), organization_id: actor.organizationId, active: true, access_status: "active", kind: "ai", role: "dispatcher" },
    ]);
    expect(await getMobileCaseOwner(actor, id(5), undefined, f.admin)).toMatchObject({ available: true, caseRevision: revision, owner: { id: null, mine: false }, capabilities: { take: true, assign: true }, targets: [{ id: id(2), name: "Jana" }, { id: id(4), name: "Peter" }] });
  });
  it.each([[null,"cancelled",false,false], [id(4),"cancelled",false,true], [id(4),"open",false,true], [null,"waiting_for_docs",true,true]])("capabilities owner=%s state=%s", async (owner,status,take,assign) => {
    const f = fixture(owner as string | null, status as string);
    expect((await getMobileCaseOwner(actor,id(5),undefined,f.admin)).capabilities).toEqual({take,assign});
  });
  it("only missing capability is unavailable, errors fail closed", async () => {
    const f = fixture();
    f.db.registerRpc("motorist_case_owner_version", () => { throw { code: "PGRST202", message: "Could not find public.motorist_case_owner_version" }; });
    expect(await getMobileCaseOwner(actor,id(5),undefined,f.admin)).toMatchObject({available:false,targets:[],capabilities:{take:false,assign:false}});
    f.db.registerRpc("motorist_case_owner_version", () => { throw { code:"42501", message:"denied" }; });
    await expect(getMobileCaseOwner(actor,id(5),undefined,f.admin)).rejects.toMatchObject({status:503});
  });
  it.each(["unrelated_function", "motorist_case_owner_version_shadow"])("missing RPC %s is not feature unavailable",async name=>{
    const f=fixture();f.db.registerRpc("motorist_case_owner_version",()=>{throw{code:"PGRST202",message:`missing ${name}`};});
    await expect(getMobileCaseOwner(actor,id(5),undefined,f.admin)).rejects.toMatchObject({status:503});
    f.db.registerRpc("motorist_assign_case_owner",()=>{throw{code:"PGRST202",message:`missing ${name}`};});
    await expect(assignMobileCaseOwner(actor,id(5),input,f.admin)).rejects.toMatchObject({status:503,code:"CASE_SAVE_UNCONFIRMED"});
  });
  it("rejects a context whose case changed between dependency reads",async()=>{
    const f=fixture();f.db.registerRpc("motorist_case_owner_version",()=>{f.db.update("motorist_cases",{updated_at:"2026-10-12T18:00:00.000002Z"},r=>r.id===id(5));return 1;});
    await expect(getMobileCaseOwner(actor,id(5),undefined,f.admin)).rejects.toMatchObject({status:503});
  });
  it("reports only the exact missing mutation as unavailable",async()=>{
    const f=fixture();f.db.registerRpc("motorist_assign_case_owner",()=>{throw{code:"PGRST202",message:"Could not find public.motorist_assign_case_owner in schema cache"};});
    await expect(assignMobileCaseOwner(actor,id(5),input,f.admin)).rejects.toMatchObject({status:503,code:"assignment_unavailable"});
  });
  it("does not offer an active profile without a login account",async()=>{
    const f=fixture();f.db.update("motorist_profiles",{user_id:null},r=>r.id===id(4));
    expect((await getMobileCaseOwner(actor,id(5),undefined,f.admin)).targets.map(x=>x.id)).toEqual([actor.profileId]);
  });
  it("shows inactive historical owner without offering it; foreign case is404", async () => {
    const f = fixture(id(12));
    f.db.seed("motorist_profiles", [{id:id(12),organization_id:actor.organizationId,display_name:"Retired",active:false}]);
    expect((await getMobileCaseOwner(actor,id(5),undefined,f.admin)).owner).toEqual({id:id(12),name:"Retired",mine:false});
    await expect(getMobileCaseOwner({...actor,organizationId:id(80)},id(5),undefined,f.admin)).rejects.toMatchObject({status:404});
  });
  it("does not offer writes if actor eligibility changed after HTTP auth", async () => {
    const f=fixture();f.db.update("motorist_profiles",{active:false},r=>r.id===actor.profileId);
    expect((await getMobileCaseOwner(actor,id(5),undefined,f.admin)).capabilities).toEqual({take:false,assign:false});
  });
  it("fences capabilities when the profile login was rebound after HTTP auth",async()=>{
    const f=fixture();f.db.update("motorist_profiles",{user_id:id(80)},r=>r.id===actor.profileId);
    expect((await getMobileCaseOwner(actor,id(5),undefined,f.admin)).capabilities).toEqual({take:false,assign:false});
  });
  it("unrecognized capability version does not expose writable targets",async()=>{
    const f=fixture();f.db.registerRpc("motorist_case_owner_version",()=>2);
    expect(await getMobileCaseOwner(actor,id(5),undefined,f.admin)).toMatchObject({available:false,targets:[],capabilities:{take:false,assign:false}});
  });
  it("normalizes UUID text only, keeping microsecond revision exact",()=>{
    const value={...input,ownerId:"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",mutationId:"BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB"};
    expect(parseMobileCaseOwner(value)).toEqual({...value,ownerId:value.ownerId.toLowerCase(),mutationId:value.mutationId.toLowerCase()});
  });
  it("explicitly rejects directory overflow", async () => {
    const f=fixture(); f.db.seed("motorist_profiles",Array.from({length:199},(_,i)=>({id:id(100+i),user_id:id(500+i),organization_id:actor.organizationId,display_name:"Target",active:true,access_status:"active",kind:"human",role:"admin"})));
    await expect(getMobileCaseOwner(actor,id(5),undefined,f.admin)).rejects.toMatchObject({status:503,code:"case_dispatchers_limit"});
  });
  it("sends one exact command with actor scope and accepts stable no-op receipt without rereads", async () => {
    const f=fixture(); const rpc=vi.fn((args: Record<string, unknown>)=>{ expect(args.p_actor_user_id).toBe(actor.userId); return ({caseId:id(5),mutationId:input.mutationId,ownerId:input.ownerId,committedRevision:revision,organizationId:actor.organizationId,actorId:actor.profileId}); });
    f.db.registerRpc("motorist_assign_case_owner",rpc);
    const result=await assignMobileCaseOwner(actor,id(5),input,f.admin);
    expect(result).toEqual({caseId:id(5),mutationId:input.mutationId,ownerId:input.ownerId,committedRevision:revision,refreshRequired:true});
    expect(rpc).toHaveBeenCalledOnce(); expect(rpc.mock.calls[0][0]).toMatchObject({p_actor_id:actor.profileId,p_organization_id:actor.organizationId,p_case_id:id(5),p_owner_id:input.ownerId,p_expected_updated_at:revision,p_mutation_id:input.mutationId,p_fingerprint:expect.stringMatching(/^[a-f0-9]{64}$/)});
    expect(f.db.log.filter(x=>x.kind==="query")).toHaveLength(0);
  });
  it("keeps retry fingerprints stable but separates target, revision and V1 editor identity", async () => {
    const f = fixture();
    const fingerprints: string[] = [];
    f.db.registerRpc("motorist_assign_case_owner", args => {
      fingerprints.push(String(args.p_fingerprint));
      return { caseId: id(5), mutationId: args.p_mutation_id, ownerId: args.p_owner_id,
        committedRevision: args.p_expected_updated_at, organizationId: actor.organizationId, actorId: actor.profileId };
    });
    await assignMobileCaseOwner(actor, id(5), input, f.admin);
    await assignMobileCaseOwner(actor, id(5), { ownerId: input.ownerId, expectedUpdatedAt: revision, mutationId: input.mutationId }, f.admin);
    await assignMobileCaseOwner(actor, id(5), { ...input, ownerId: actor.profileId }, f.admin);
    await assignMobileCaseOwner(actor, id(5), { ...input, expectedUpdatedAt: "2026-10-12T18:00:00.000002Z" }, f.admin);
    expect(fingerprints[0]).toBe(fingerprints[1]);
    expect(new Set([fingerprints[0], fingerprints[2], fingerprints[3]]).size).toBe(3);
    expect(fingerprints[0]).not.toBe(caseMutationIdentity(input)?.fingerprint);
  });
  it.each(["PT409","PT422","42501","P0002","XX000"])("maps RPC failure %s without fabricating a receipt",async code=>{
    const f=fixture();f.db.registerRpc("motorist_assign_case_owner",()=>{throw{code,message:"private detail"};});
    await expect(assignMobileCaseOwner(actor,id(5),input,f.admin)).rejects.toMatchObject({status:({PT409:409,PT422:422,"42501":403,P0002:404,XX000:503})[code]});
  });
  it.each([null,{}, {organizationId:id(80)},{ownerId:id(80)},{mutationId:id(80)},{caseId:id(80)},{committedRevision:"2026-10-12T18:00:00.000000Z"}])("rejects malformed/foreign receipt %j",async patch=>{
    const f=fixture();f.db.registerRpc("motorist_assign_case_owner",()=> patch===null?null:({...{caseId:id(5),mutationId:input.mutationId,ownerId:input.ownerId,committedRevision:revision,organizationId:actor.organizationId,actorId:actor.profileId},...patch, ...(Object.keys(patch).length===0?{actorId:null}:{})}));
    await expect(assignMobileCaseOwner(actor,id(5),input,f.admin)).rejects.toMatchObject({status:503,code:"CASE_SAVE_UNCONFIRMED"});
  });
});
