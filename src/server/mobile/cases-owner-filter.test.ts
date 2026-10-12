import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { listMobileCases, parseMobileCaseQuery } from "./cases";
const id=(n:number)=>`40000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const actor={userId:id(1),profileId:id(2),organizationId:id(3),displayName:"Actor",role:"dispatcher" as const};
const at="2026-10-12T18:00:00.000001Z";
const query=(text="")=>parseMobileCaseQuery(new URLSearchParams(text));
function fixture(){const f=createFakeSupabase();f.db.seed("motorist_cases",Array.from({length:8},(_,i)=>({id:id(10+i),organization_id:i===7?id(80):actor.organizationId,owner_id:i===6?id(90):null,case_number:`PM${i}`,status:i===5?"cancelled":"open",priority:"normal",created_at:i===4?"2026-10-12T18:00:00.000002Z":at,updated_at:at,summary:"Search",contact_id:id(40),vehicle_id:id(41),customer_details:{},vehicle_details:{},incident_details:{},location_details:{},replacement_vehicle_details:{},payment_details:{},closure_details:{},attachments_metadata:[]})));f.db.seed("motorist_contacts",[{id:id(40),organization_id:actor.organizationId,name:"Contact",phone:"123"}]);f.db.seed("motorist_vehicles",[{id:id(41),organization_id:actor.organizationId,license_plate:"PLATE"}]);return f;}
describe("unassigned case filter",()=>{
  it("accepts explicit unassigned and rejects mixed owner, preserves defaults",()=>{
    expect(query("ownership=unassigned").ownership).toBe("unassigned");expect(query().ownership).toBe("all");
    expect(()=>query(`ownership=unassigned&ownerId=${id(5)}`)).toThrow();
  });
  it("filters owner null before pagination with microseconds and cursor binding",async()=>{
    const f=fixture();const first=await listMobileCases(actor,query("ownership=unassigned&limit=2"),undefined,f.admin);
    expect(first.cases.map(c=>c.id)).toEqual([id(14),id(13)]);expect(first.selection).toMatchObject({ownership:"unassigned",ownerId:null});
    const second=await listMobileCases(actor,query(`ownership=unassigned&limit=2&cursor=${first.nextCursor}`),undefined,f.admin);expect(second.cases.map(c=>c.id)).toEqual([id(12),id(11)]);
    await expect(listMobileCases(actor,query(`ownership=all&cursor=${first.nextCursor}`),undefined,f.admin)).rejects.toMatchObject({status:400});
    expect((await listMobileCases(actor,query("ownership=unassigned&category=all"),undefined,f.admin)).cases.map(c=>c.id)).toContain(id(15));
  });
  it.each(["Search","Contact","123","PLATE","PM"])("applies unassigned scope through search branch %s",async q=>{
    const f=fixture();const result=await listMobileCases(actor,query(`ownership=unassigned&q=${q}`),undefined,f.admin);expect(result.cases).toHaveLength(5);expect(result.cases.every(c=>c.owner.id===null)).toBe(true);
    const caseReads=f.db.log.filter(x=>x.table==="motorist_cases");expect(caseReads.filter(x=>x.filters?.includes("is(owner_id)")).length).toBeGreaterThan(0);
  });
});
