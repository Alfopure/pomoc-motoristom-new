import { describe, expect, it } from "vitest";
import { confirmCoordinates, editStop, chooseStop, routeInput, routeNavigationUrl, type RouteStop } from "./route-model";
const stop: RouteStop = { id:1,address:"Bratislava",selection:null };
describe("deliberate route point selection",()=>{
  it("does not coerce empty coordinates into zero or accept nonfinite/out-of-range values",()=>{
    for(const [lat,lng] of [["","0"],["0"," "],["91","0"],["0","181"],["Infinity","0"],["NaN","0"]]) expect(()=>confirmCoordinates(stop,lat,lng)).toThrow();
    expect(confirmCoordinates(stop,"0","0").selection).toMatchObject({lat:0,lng:0,provider:"manual"});
  });
  it("editing an address removes its previously chosen coordinate anchor",()=>{
    const chosen=confirmCoordinates(stop,"48.1","17.1");expect(editStop(chosen,"Košice")).toEqual({...stop,address:"Košice"});
    expect(()=>routeInput([editStop(chosen,"Košice"),chosen])).toThrow();
  });
  it("copies selected points so later map mutation cannot change a prepared route",()=>{
    const selection={label:"Bod",address:"Bod",lat:48,lng:17,provider:"manual" as const};const chosen=chooseStop(stop,selection);
    selection.lat=49;expect(chosen.selection?.lat).toBe(48);expect(routeInput([chosen,confirmCoordinates({...stop,id:2},"50","18")])).toEqual({origin:{lat:48,lng:17},destination:{lat:50,lng:18},intermediates:[]});
  });
  it("preserves stop order and rejects excessive stops rather than truncating",()=>{
    const stops=Array.from({length:27},(_,i)=>confirmCoordinates({...stop,id:i},String(i),"0"));
    expect(routeInput(stops).intermediates).toHaveLength(25);expect(()=>routeInput([...stops,stops[0]])).toThrow();
    expect(routeInput(stops.slice().reverse()).origin.lat).toBe(26);
  });
  it("external navigation uses fixed HTTPS and numeric points, never address URL content",()=>{
    const stops=[confirmCoordinates({...stop,address:"https://evil.example/?token=x"},"48","17"),confirmCoordinates(stop,"49","18")];
    const url=new URL(routeNavigationUrl(stops));expect(url.origin).toBe("https://www.google.com");expect(url.searchParams.get("origin")).toBe("48,17");expect(url.href).not.toContain("evil");
    expect(()=>routeNavigationUrl(Array.from({length:6},(_,i)=>confirmCoordinates({...stop,id:i},String(i),"0")))).toThrow();
  });
});
