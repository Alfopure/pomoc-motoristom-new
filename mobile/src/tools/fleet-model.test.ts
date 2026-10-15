import { expect, it } from "vitest";
import { fleetFreshness } from "./fleet-model";
import type { MobileToolFleetAsset } from "../../../src/lib/mobile-tools";
const now=Date.parse("2026-10-15T12:00:00Z");
const asset={point:{lat:0,lng:0},gps:{source:"Commander",positionTime:"2026-10-15T11:59:00Z",syncedAt:"2026-10-15T11:59:00Z",stale:false},occupancy:"free",occupancyCheckedAt:"2026-10-15T11:59:00Z",availabilityVerified:true} as MobileToolFleetAsset;
it("ages GPS and occupancy independently without freezing server freshness",()=>{
  expect(fleetFreshness(asset,now)).toEqual({gpsFresh:true,availability:"free"});
  expect(fleetFreshness(asset,now+11*60000)).toEqual({gpsFresh:false,availability:"stale"});
  expect(fleetFreshness({...asset,gps:null},now)).toEqual({gpsFresh:false,availability:"free"});
  expect(fleetFreshness({...asset,occupancy:"occupied"},now)).toEqual({gpsFresh:true,availability:"occupied"});
});
it("never promotes absent/future/unknown evidence into current position or available vehicle",()=>{
  expect(fleetFreshness({...asset,point:null,occupancy:"unverified",availabilityVerified:null},now)).toEqual({gpsFresh:false,availability:"unverified"});
  expect(fleetFreshness({...asset,occupancyCheckedAt:"2026-10-16T00:00:00Z",gps:{...asset.gps!,positionTime:"2026-10-16T00:00:00Z"}},now)).toEqual({gpsFresh:false,availability:"stale"});
  expect(fleetFreshness({...asset,occupancy:"unverified"},now).availability).toBe("unverified");
});
it("uses a current committed occupancy observation without inventing an explicit metadata flag",()=>{
  expect(fleetFreshness({...asset,availabilityVerified:null},now).availability).toBe("free");
  expect(fleetFreshness({...asset,availabilityVerified:null,occupancy:"occupied"},now).availability).toBe("occupied");
  expect(fleetFreshness({...asset,availabilityVerified:false},now).availability).toBe("unverified");
});
it("allows the existing one-minute clock tolerance without accepting far-future observations",()=>{
  const time=new Date(now+5000).toISOString();
  expect(fleetFreshness({...asset,occupancyCheckedAt:time,gps:{...asset.gps!,positionTime:time,syncedAt:time}},now)).toEqual({gpsFresh:true,availability:"free"});
});
