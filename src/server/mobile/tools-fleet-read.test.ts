import { afterEach, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
const state=vi.hoisted(()=>({admin:null as unknown}));
vi.mock("@/lib/supabase/admin",()=>({createSupabaseAdminClient:()=>state.admin}));
import { loadFleetData } from "@/data/dispatch-repository";
const org="11111111-1111-4111-8111-111111111111";
afterEach(()=>vi.restoreAllMocks());
function fixture(fault?:"missing-count"|"truncated"|"overflow"|"error") {const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{void init;const url=new URL(String(input));const table=url.pathname.split('/').at(-1);const count=table==='motorist_fleet_asset_links'&&fault==='overflow'?1001:table==='motorist_fleet_asset_links'&&fault==='truncated'?5:0;return new Response(JSON.stringify(table==='motorist_fleet_asset_links'&&fault==='error'?{message:'privateDB'}:[]),{status:table==='motorist_fleet_asset_links'&&fault==='error'?500:200,headers:{'content-type':'application/json',...(fault==='missing-count'?{}:{'content-range':`*/${count}`})}});});state.admin=createClient('https://fixture.example.test','fixture',{global:{fetch:fetcher},auth:{persistSession:false}});return fetcher;}
it("all bounded source reads use exact actor organization and count",async()=>{const fetcher=fixture();expect(await loadFleetData(org,undefined,{maxRows:1000})).toMatchObject({fleetAssets:[]});for(const [input,init]of fetcher.mock.calls){const url=new URL(String(input));expect(url.searchParams.get('organization_id')).toBe('eq.'+org);if(!['motorist_fleet_sync_runs','motorist_fleet_replacement_occupancy'].includes(url.pathname.split('/').at(-1)!)){expect(url.searchParams.get('limit')).toBe('1001');expect(new Headers((init as RequestInit|undefined)?.headers).get('prefer')).toContain('count=exact');}}});
it.each(['missing-count','truncated','overflow','error'] as const)("fails closed for %s on related source",async kind=>{fixture(kind);await expect(loadFleetData(org,undefined,{maxRows:1000})).rejects.toThrow();});
it("preserves unbounded web default contract without requiring counts",async()=>{fixture('missing-count');expect(await loadFleetData(org)).toMatchObject({fleetAssets:[]});});
