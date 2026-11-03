import { describe, expect, it, vi } from "vitest";
import { MobileApiError } from "../lib/api";
import { ToolRequest } from "./request";

function deferred<T>() { let resolve!: (value:T)=>void, reject!: (error:unknown)=>void; const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; }
describe("explicit scoped tools requests",()=>{
  it("never starts while inactive and blocks same-tick double taps",async()=>{
    const request=new ToolRequest<string>();const pending=deferred<string>();const operation=vi.fn(()=>pending.promise);
    await request.run(operation);expect(operation).not.toHaveBeenCalled();request.setActive(true);
    const first=request.run(operation);await request.run(operation);expect(operation).toHaveBeenCalledTimes(1);
    pending.resolve("verified");await first;expect(request.snapshot().data).toBe("verified");
  });
  it("input change cancels and discards late success while a new request wins",async()=>{
    const request=new ToolRequest<string>();request.setActive(true);const old=deferred<string>();let signal!:AbortSignal;
    const first=request.run(s=>{signal=s;return old.promise;});request.invalidate();expect(signal.aborted).toBe(true);
    await request.run(async()=>"new input");old.resolve("old input");await first;expect(request.snapshot().data).toBe("new input");
  });
  it.each(["hidden","disposed"])("%s discards late failure and never automatically retries",async mode=>{
    const request=new ToolRequest<string>();request.setActive(true);const pending=deferred<string>();const op=vi.fn(()=>pending.promise);
    const run=request.run(op);if(mode==="hidden")request.setActive(false);else request.dispose();
    pending.reject(new MobileApiError("Old failure",503));await run;request.setActive(true);
    expect(op).toHaveBeenCalledTimes(1);expect(request.snapshot()).toMatchObject({data:null,error:null,busy:false});
    if(mode==="disposed"){await request.run(op);expect(op).toHaveBeenCalledTimes(1);}
  });
  it("429 cooldown survives input edits and only permits a deliberate later retry",async()=>{
    let now=1000;const request=new ToolRequest<string>(()=>now);request.setActive(true);
    const error=Object.assign(new MobileApiError("Počkajte chvíľu.",429),{retryAfterSeconds:30});
    const op=vi.fn(async()=>{throw error;});await request.run(op);request.invalidate();await request.run(op);expect(op).toHaveBeenCalledTimes(1);
    now+=30001;expect(request.remainingSeconds()).toBe(0);expect(op).toHaveBeenCalledTimes(1);
    await request.run(async()=>"retried");expect(request.snapshot().data).toBe("retried");
  });
  it.each([0,409])("preserves supplied retry delay for uncertain or pending lookup status %s",async status=>{
    const request=new ToolRequest<string>(()=>1000);request.setActive(true);const op=vi.fn(async()=>{throw Object.assign(new MobileApiError("Ešte sa spracúva",status),{retryAfterSeconds:5});});
    await request.run(op);await request.run(op);expect(op).toHaveBeenCalledTimes(1);expect(request.remainingSeconds()).toBe(5);
  });
  it("uses the bounded fallback wait when 429 omits Retry-After",async()=>{
    const request=new ToolRequest<string>(()=>1000);request.setActive(true);await request.run(async()=>{throw new MobileApiError("Limit",429);});expect(request.remainingSeconds()).toBe(30);
  });
  it("bounds untrusted cooldown values and clears old data before a failed refresh",async()=>{
    const request=new ToolRequest<string>(()=>1000);request.setActive(true);await request.run(async()=>"old");
    await request.run(async()=>{throw Object.assign(new MobileApiError("Limit",429),{retryAfterSeconds:900000});});
    expect(request.snapshot().data).toBeNull();expect(request.remainingSeconds()).toBe(300);
  });
});
