import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { getMobileCallContext, parseCallContextTarget } from "./call-context";
const org="11111111-1111-4111-8111-111111111111", actorId="22222222-2222-4222-8222-222222222222", callId="33333333-3333-4333-8333-333333333333", sessionId="44444444-4444-4444-8444-444444444444", caseId="55555555-5555-4555-8555-555555555555", other="66666666-6666-4666-8666-666666666666";
const actor={organizationId:org,profileId:actorId,userId:actorId,displayName:"Jana",role:"dispatcher" as const};
const at="2026-10-15T19:00:00.123456Z";
type Row=Record<string,unknown>;
function fixture() {
 vi.stubEnv("MOTORIST_APP_ENV","test");
 const rows:Record<string,Row[]>={
  motorist_calls:[{id:callId,organization_id:org,session_id:sessionId,direction:"outbound",status:"ended",caller_number:"+421111111111",called_number:"+421222222222",destination_number:"+421333333333",caller_name:"Klient",line_id:other,operator_id:actorId,case_id:caseId,started_at:at,created_at:at,answered_at:at,ended_at:at,duration_seconds:0,raw_payload:{secret:"raw-secret"},provider_call_id:"provider-secret"}],
  motorist_call_sessions:[{id:sessionId,organization_id:org,direction:"outbound",state:"talking",caller_number:"+421111111111",called_number:"+421333333333",case_id:caseId,answered_by_profile_id:actorId,line_id:other,started_at:at,answered_at:at,ended_at:null,metadata:{environment:"development"}}],
  motorist_cases:[{id:caseId,organization_id:org,case_number:"2026-42",status:"open",summary:"Pomoc na ceste",contact_id:other,vehicle_id:other,owner_id:actorId,updated_at:at}],
  motorist_profiles:[{id:actorId,organization_id:org,display_name:"Jana"}],
  motorist_contacts:[{id:other,organization_id:org,name:"Klient",notes:"private-note"}],
  motorist_vehicles:[{id:other,organization_id:org,license_plate:"BA123AB",vin:"private-vin"}],
  motorist_telephony_lines:[{id:other,organization_id:org,label:"Linka"}],
 };
 let failure:string|null=null;
 let onRead:((table:string)=>void)|undefined;
 const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(String(input)), table=url.pathname.split('/').at(-1)!;
  onRead?.(table);
  expect(init?.method??"GET").toBe("GET");
  expect(url.searchParams.get("organization_id")).toBe("eq."+org);
  expect(url.searchParams.get("select")).not.toContain("*");
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  if(table===failure)return new Response(JSON.stringify({message:"private-db-detail"}),{status:500});
  let result=rows[table]??[];
  for(const [key,value] of url.searchParams){if(value.startsWith("eq."))result=result.filter(r=>r[key]===value.slice(3));if(value==="is.null")result=result.filter(r=>r[key]===null);if(key==="metadata"&&value.startsWith("cs."))result=result.filter(r=>(r.metadata as Row)?.environment===JSON.parse(value.slice(3)).environment);}
  result=result.slice(0,Number(url.searchParams.get("limit")??100));
  return new Response(JSON.stringify(result),{headers:{"content-type":"application/json"}});
 });
 const db=createClient<Database>("https://fixture.example.test","fixture",{global:{fetch:fetcher},auth:{persistSession:false}});
 return {rows,fetcher,db,setOnRead:(fn:(table:string)=>void)=>{onRead=fn;},fail:(table:string)=>{failure=table;},read:(kind:"call"|"session"="call")=>getMobileCallContext(actor,{kind,id:kind==="call"?callId:sessionId},undefined,db)};
}
afterEach(()=>vi.unstubAllEnvs());
describe("bounded explicit mobile call context",()=>{
 it("projects linked history and zero duration without private payloads",async()=>{const f=fixture();const value=await f.read();expect(value).toMatchObject({target:{kind:"call",id:callId},call:{id:callId,sessionId,number:"+421333333333",durationSeconds:0,operatorName:"Jana",lineLabel:"Linka"},linkState:"linked",linkedCase:{id:caseId,caseNumber:"2026-42",contactName:"Klient",licensePlate:"BA123AB"}});expect(JSON.stringify(value)).not.toMatch(/private-|provider-secret|raw-secret/);});
 it("uses session state and TEST development namespace",async()=>{const f=fixture();expect(await f.read("session")).toMatchObject({call:{status:"talking",endedAt:null},linkState:"linked"});expect(f.fetcher.mock.calls.some(([u])=>new URL(String(u)).searchParams.get("metadata")==='cs.{"environment":"development"}')).toBe(true);});
 it("never falls back from wrong source or foreign primary",async()=>{const f=fixture();f.rows.motorist_calls[0].organization_id=other;await expect(f.read()).rejects.toMatchObject({status:404});});
 it("denies another operator active session despite same organization",async()=>{const f=fixture();f.rows.motorist_call_sessions[0].answered_by_profile_id=other;await expect(f.read("session")).rejects.toMatchObject({status:404});});
 it.each(["motorist_call_legs","motorist_ring_attempts"])("permits exact current console evidence %s",async table=>{const f=fixture();f.rows.motorist_call_sessions[0].answered_by_profile_id=other;f.rows[table]=[{id:other,organization_id:org,session_id:sessionId,profile_id:actorId,ended_at:null,result:"offered"}];expect(await f.read("session")).toMatchObject({target:{kind:"session",id:sessionId}});});
 it("denies wrong persisted environment",async()=>{const f=fixture();f.rows.motorist_call_sessions[0].metadata={environment:"production"};await expect(f.read("session")).rejects.toMatchObject({status:404});});
 it.each(["missing-case","foreign-case","conflict","missing-session"])("marks broken link %s unavailable",async fault=>{const f=fixture();if(fault==="missing-case")f.rows.motorist_cases=[];if(fault==="foreign-case")f.rows.motorist_cases[0].organization_id=other;if(fault==="conflict")f.rows.motorist_call_sessions[0].case_id=other;if(fault==="missing-session")f.rows.motorist_call_sessions=[];expect(await f.read()).toMatchObject({linkState:"unavailable",linkedCase:null});});
 it("does not label one-sided projection link unlinked",async()=>{const f=fixture();f.rows.motorist_calls[0].case_id=null;expect(await f.read()).toMatchObject({linkState:"unavailable",linkedCase:null});});
 it("both explicit null links are unlinked without case reads",async()=>{const f=fixture();f.rows.motorist_calls[0].case_id=null;f.rows.motorist_call_sessions[0].case_id=null;expect(await f.read()).toMatchObject({linkState:"unlinked",linkedCase:null});expect(f.fetcher.mock.calls.some(([u])=>String(u).includes("motorist_cases"))).toBe(false);});
 it("internal extensions are never customer numbers",async()=>{const f=fixture();f.rows.motorist_calls[0].direction="internal";f.rows.motorist_call_sessions[0].direction="internal";f.rows.motorist_calls[0].caller_number="sip:private@host";expect(await f.read()).toMatchObject({call:{direction:"internal",number:null}});});
 it("ambiguous history projections do not choose a case",async()=>{const f=fixture();f.rows.motorist_calls.push({...f.rows.motorist_calls[0],id:other});expect(await f.read("session")).toMatchObject({call:{id:null},linkedCase:null,linkState:"unavailable"});});
 it("rejects a concurrent relink after reading case details",async()=>{const f=fixture();f.setOnRead(table=>{if(table==="motorist_contacts")f.rows.motorist_calls[0]={...f.rows.motorist_calls[0],case_id:other};});await expect(f.read()).rejects.toMatchObject({status:503});});
 it("missing optional scoped related records stay null without foreign disclosure",async()=>{const f=fixture();for(const table of ["motorist_contacts","motorist_vehicles","motorist_profiles","motorist_telephony_lines"])for(const row of f.rows[table])row.organization_id=other;expect(await f.read()).toMatchObject({call:{operatorName:null,lineLabel:null},linkedCase:{contactName:null,licensePlate:null,ownerName:null}});});
 it("bounds labels and multiline summary while preserving canonical IDs",async()=>{const f=fixture();f.rows.motorist_calls[0].caller_name="x".repeat(220);f.rows.motorist_cases[0].summary="line\n".repeat(500);const value=await f.read();expect(value.call.name).toHaveLength(200);expect(value.linkedCase?.summary).toHaveLength(2000);expect(value.linkedCase?.summary).toContain("\n");});
 it.each(["sip:secret@provider", "<script>", "1".repeat(90), "", null])("non-customer destination %s is not transferable",async destination=>{const f=fixture();f.rows.motorist_calls[0].destination_number=destination;f.rows.motorist_calls[0].called_number=destination;expect(await f.read()).toMatchObject({call:{number:null}});});
 it.each([-1,1.5])("invalid duration %s fails closed",async duration=>{const f=fixture();f.rows.motorist_calls[0].duration_seconds=duration;await expect(f.read()).rejects.toMatchObject({status:503});});
 it("DB failure is not empty success",async()=>{const f=fixture();f.fail("motorist_cases");await expect(f.read()).rejects.toMatchObject({status:503});});
 it("rejects inconsistent call/session direction",async()=>{const f=fixture();f.rows.motorist_call_sessions[0].direction="internal";await expect(f.read()).rejects.toMatchObject({status:503});});
 it.each(["motorist_call_legs","motorist_ring_attempts"])("revoked %s evidence during linked-case read denies session response",async table=>{const f=fixture();f.rows.motorist_call_sessions[0].answered_by_profile_id=other;f.rows[table]=[{id:other,organization_id:org,session_id:sessionId,profile_id:actorId,ended_at:null,result:"offered"}];f.setOnRead(name=>{if(name==="motorist_cases")f.rows[table]=[];});await expect(f.read("session")).rejects.toMatchObject({status:404});});
 it("ended or foreign actor evidence cannot grant console visibility",async()=>{const f=fixture();f.rows.motorist_call_sessions[0].answered_by_profile_id=other;f.rows.motorist_call_legs=[{id:other,organization_id:org,session_id:sessionId,profile_id:actorId,ended_at:at}];f.rows.motorist_ring_attempts=[{id:other,organization_id:other,session_id:sessionId,profile_id:actorId,result:"offered"}];await expect(f.read("session")).rejects.toMatchObject({status:404});});
 it("production session uses its own persisted namespace",async()=>{const f=fixture();vi.stubEnv("MOTORIST_APP_ENV","production");f.rows.motorist_call_sessions[0].metadata={environment:"production"};expect(await f.read("session")).toMatchObject({target:{kind:"session",id:sessionId}});});
 it("aborted requests do not read",async()=>{const f=fixture();await expect(getMobileCallContext(actor,{kind:"call",id:callId},AbortSignal.abort(),f.db)).rejects.toBeDefined();expect(f.fetcher).not.toHaveBeenCalled();});
 it.each(["", "source=other", "source=call&source=session", "source=call&extra=1"])("rejects query %s",q=>{expect(()=>parseCallContextTarget(callId,new URLSearchParams(q))).toThrow();});
 it("rejects invalid id and preserves exact target",()=>{expect(()=>parseCallContextTarget("bad",new URLSearchParams("source=call"))).toThrow();expect(parseCallContextTarget(callId,new URLSearchParams("source=call"))).toEqual({kind:"call",id:callId});});
});
