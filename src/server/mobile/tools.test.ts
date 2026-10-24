import { describe, expect, it, vi } from "vitest";
import { parseToolLookup, parseToolRoute, parseToolFleetFilter, projectToolLookup, projectToolFleet } from "./tools";
import type { FleetData } from "@/data/dispatch-types";
import type { VehicleLookupResponse } from "@/lib/vehicle-lookup";
const id = "11111111-1111-4111-8111-111111111111";
const at = "2026-10-15T17:00:00.000Z";
const point = { lat: 48, lng: 17 };
const asset = { id,kind:"replacement_car",label:"Auto",licensePlate:"BA123AB",status:"available",internalStatus:"available",branchId:"private",point,lastSeen:at,positionKnown:false,capabilities:[],notes:"private",assignedDriverPhone:"secret",occupancy:"unverified" };
const fleet = (assets:unknown[]) => ({fleetAssets:assets,fleetProviderVehicles:[],commanderVehicles:[],integrations:[],commanderGpsLastSuccessAt:at}) as unknown as FleetData;
const fleetAssets = (count: number) => Array.from({ length: count }, (_, index) => ({
  ...asset,
  id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
  label: `Auto ${String(index).padStart(4, "0")}`,
  licensePlate: `BA${String(index).padStart(4, "0")}AB`,
}));
const lookup = {snapshot:{proof:"private-seal",result:{version:1,id,query:{kind:"plate",value:"BA123AB",country:"SK",checkedForDate:"2026-10-15"},fetchedAt:at,sources:[{source:"skp",status:"unavailable",url:"https://provider.test/?key=private",fetchedAt:at,facts:{},warnings:["Zdroj nedostupný"],reports:[{url:"private",title:"private"}]}]}},cached:false} as VehicleLookupResponse;
describe("strict mobile tool boundaries",()=>{
 it.each([{kind:["plate"],value:"BA123AB",country:"SK"},{kind:"plate",value:"BA123AB",country:"SK",organizationId:id},{kind:"plate",value:"BA123AB",country:"SK",knownIdentity:[]},{kind:"plate",value:"BA123AB",country:"SK",knownIdentity:{proof:"bad"}}])("rejects lookup coercion/spoof %j",body=>expect(()=>parseToolLookup(body)).toThrow());
 it("normalizes explicit identifiers while preserving a conflict check",()=>expect(parseToolLookup({kind:"plate",value:" ba-123ab ",country:"SK",knownIdentity:{vin:"WVWZZZ1JZXW000001"}})).toMatchObject({query:{value:"BA123AB"},knownIdentity:{vin:"WVWZZZ1JZXW000001"}}));
 it.each([{origin:point,destination:point,key:"x"},{origin:{lat:null,lng:17},destination:point},{origin:{...point,providerId:"x"},destination:point},{origin:point,destination:point,intermediates:Array(26).fill(point)}])("rejects route extras/coercion %j",body=>expect(()=>parseToolRoute(body)).toThrow());
 it("accepts zero coordinates and preserves point order",()=>expect(parseToolRoute({origin:{lat:0,lng:0},destination:point,intermediates:[{lat:1,lng:2}]})).toEqual({origin:{lat:0,lng:0},destination:point,intermediates:[{lat:1,lng:2}]}));
 it.each(["q=a&q=b","kind[]=tow_truck","status=made_up","offset=-1","offset=1.5","offset=1001","actorId=other"])("rejects invalid fleet query %s",q=>expect(()=>parseToolFleetFilter(new URLSearchParams(q))).toThrow());
 it("returns normalized exact fleet filters",()=>expect(parseToolFleetFilter(new URLSearchParams("q=%20auto%20"))).toEqual({q:"auto",kind:"all",status:"all",offset:0}));
 it("projects source truth without proof, URL or report payload",()=>{const result=projectToolLookup(lookup,{});expect(result).toMatchObject({cached:false,conflict:null,result:{sources:[{status:"unavailable",facts:{},candidates:[]}]}});expect(JSON.stringify(result)).not.toMatch(/private|proof|reports|url/);});
 it("fails malformed facts rather than silently dropping them",()=>{const copy=structuredClone(lookup);copy.snapshot.result.sources[0].facts={vin:{value:"x".repeat(181),quality:"reported"}};expect(()=>projectToolLookup(copy,{})).toThrow();});
 it("does not present branch fallback or unknown occupancy as GPS/free",()=>{const result=projectToolFleet(fleet([asset]),parseToolFleetFilter(new URLSearchParams()));expect(result.assets[0]).toMatchObject({point:null,gps:null,occupancy:"unverified",availabilityVerified:null});expect(JSON.stringify(result)).not.toMatch(/private|secret|branchId|notes/);});
 it("keeps stale measured GPS and occupancy distinct",()=>{vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-15T18:00:00Z"));try{const result=projectToolFleet(fleet([{...asset,positionKnown:true,gps:{source:"commander",positionTime:at,stale:false},occupancy:"stale"}]),parseToolFleetFilter(new URLSearchParams()));expect(result.assets[0]).toMatchObject({point,gps:{stale:true},occupancy:"stale"});}finally{vi.useRealTimers();}});
 it("bounds complete snapshots and pages after filtering",()=>{const assets=fleetAssets(26);const result=projectToolFleet(fleet(assets),parseToolFleetFilter(new URLSearchParams()));expect(result).toMatchObject({total:26,nextOffset:25});expect(result.assets).toHaveLength(25);expect(()=>projectToolFleet(fleet(fleetAssets(1001)),result.selection)).toThrow();});
 it("never plots a future-dated GPS observation",()=>{const result=projectToolFleet(fleet([{...asset,positionKnown:true,gps:{source:"commander",positionTime:"2099-01-01T00:00:00Z",stale:false}}]),parseToolFleetFilter(new URLSearchParams()));expect(result.assets[0]).toMatchObject({point:null,gps:null});});
 it("keeps an identifier conflict visible and source facts separate",()=>{const copy=structuredClone(lookup);copy.snapshot.result.sources=[{source:"stkonline",status:"found",url:"private",fetchedAt:at,facts:{vin:{value:"WVWZZZ1JZXW000001",quality:"reported"}},warnings:[]}];expect(projectToolLookup(copy,{vin:"WVWZZZ1JZXW000002"})).toMatchObject({conflict:expect.any(String),result:{sources:[{facts:{vin:{value:"WVWZZZ1JZXW000001",quality:"reported"}}}]}});});
 it("returns only filtered rows on subsequent pages",()=>{const rows=Array.from({length:30},(_,i)=>({...asset,id:`11111111-1111-4111-8111-${String(i).padStart(12,"0")}`,label:`Car ${i}`,kind:i<27?"tow_truck":"replacement_car"}));const filter=parseToolFleetFilter(new URLSearchParams("kind=tow_truck&offset=25"));const result=projectToolFleet(fleet(rows),filter);expect(result).toMatchObject({selection:filter,total:27,nextOffset:null});expect(result.assets).toHaveLength(2);expect(result.assets.every(row=>row.kind==="tow_truck")).toBe(true);});

 it.each(["status","source"] as const)("rejects array-coerced source %s",field=>{const copy=structuredClone(lookup);Object.assign(copy.snapshot.result.sources[0],{[field]:[field==="source"?"skp":"found"]});expect(()=>projectToolLookup(copy,{})).toThrow();});
 it("does not retain a zero-zero branch placeholder even if marked known",()=>{expect(projectToolFleet(fleet([{...asset,positionKnown:true,point:{lat:0,lng:0},gps:{source:"commander",positionTime:at,stale:false}}]),parseToolFleetFilter(new URLSearchParams())).assets[0]).toMatchObject({point:null,gps:null});});

});

describe("mobile fleets above 200 vehicles", () => {
  it.each([298, 350, 1000])("returns every vehicle from a complete %i-vehicle snapshot", count => {
    const assets = fleetAssets(count);
    const ids: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const selection = parseToolFleetFilter(new URLSearchParams({ offset: String(offset) }));
      const page = projectToolFleet(fleet(assets), selection);
      expect(page.total).toBe(count);
      expect(page.assets.map(row => row.id)).toEqual(assets.slice(offset, offset + 25).map(row => row.id));
      ids.push(...page.assets.map(row => row.id));
      offset = page.nextOffset;
    }
    expect(ids).toEqual(assets.map(row => row.id));
    expect(new Set(ids).size).toBe(count);
  });

  it("finds a vehicle beyond 200 without exposing private fields or changing GPS/occupancy truth", () => {
    const assets = fleetAssets(350);
    const tail = { ...assets[349], positionKnown: true, gps: { source: "commander", positionTime: at, stale: true }, occupancy: "occupied", availabilityVerified: true };
    const result = projectToolFleet(fleet([...assets.slice(0, 349), tail]), parseToolFleetFilter(new URLSearchParams({ q: tail.licensePlate })));
    expect(result).toMatchObject({ total: 1, nextOffset: null, assets: [{ id: tail.id, point, gps: { stale: true }, occupancy: "occupied", availabilityVerified: true }] });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|branchId|notes/);
  });

  it("filters the full snapshot before paging and accepts the bounded final offset", () => {
    const assets = fleetAssets(350).map((row, index) => ({ ...row, status: index % 2 ? "rented" : "available" }));
    const selection = parseToolFleetFilter(new URLSearchParams("status=rented&offset=150"));
    const result = projectToolFleet(fleet(assets), selection);
    expect(result).toMatchObject({ total: 175, nextOffset: null });
    expect(result.assets.map(row => row.id)).toEqual(assets.filter(row => row.status === "rented").slice(150).map(row => row.id));
    expect(projectToolFleet(fleet(fleetAssets(1000)), parseToolFleetFilter(new URLSearchParams("offset=1000")))).toMatchObject({ total: 1000, assets: [], nextOffset: null });
  });
});
