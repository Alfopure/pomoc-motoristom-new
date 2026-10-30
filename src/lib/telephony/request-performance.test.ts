import { afterEach, describe, expect, it, vi } from "vitest";
import { callPerformanceOperation } from "./performance-operation";
import { beginRequestPerformance, readRequestPerformance, RequestPerformanceQueue, requestPerformanceQueue } from "./request-performance";
import { telephonyFetch, TelephonyRequestTimeoutError } from "./client-request";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });
describe("database-free request performance", () => {
  it("keeps precise fixed operation labels without URL, body or identity", () => {
    expect(callPerformanceOperation("https://app.test/api/telephony/calls/private/park?phone=secret", "POST")).toBe("call.park");
    expect(callPerformanceOperation("/api/telephony/calls/private/unhold")).toBe("call.unhold");
    expect(callPerformanceOperation("/api/telephony/calls/private/hold", "GET")).toBeUndefined();
    expect(callPerformanceOperation("/api/telephony/calls/private/unknown")).toBeUndefined();
    expect(readRequestPerformance([{ id: id(1), operation: "call.hold", ms: 22.55, outcome: "ok", phone: "secret", requestId: "secret" }])).toEqual([{id:id(1),operation:"call.hold",ms:22.6,outcome:"ok"}]);
    expect(readRequestPerformance([{id:id(1),operation:"call.hold",ms:-1,outcome:"ok"}, {id:id(2),operation:"call.hold",ms:Infinity,outcome:"ok"}])).toEqual([]);
    // Phone routes are measured by the server; a browser row claiming one is dropped.
    expect(readRequestPerformance([{id:id(3),operation:"mobile.hold",ms:5,outcome:"ok"}, {id:id(4),operation:"mobile.call-status",ms:5,outcome:"ok"}])).toEqual([]);
  });
  it("bounds pending observations, counts evictions, and never clears unacknowledged or newer measurements", () => {
    let now = 0; const queue = new RequestPerformanceQueue(() => now);
    for (let n=1;n<=65;n++) queue.record({id:id(n),operation:"call.hold",ms:1,outcome:"ok"});
    const batch = queue.batch(); expect(batch).toHaveLength(16); expect(queue.droppedCount()).toBe(1);
    queue.acknowledge(batch.slice(0,1),1); expect(queue.batch()[0].id).toBe(id(3));
    now = 600_001; expect(queue.batch()).toEqual([]); expect(queue.droppedCount()).toBe(63);
  });
  it("retains a valid long duration and accounts for invalid clocks instead of silently losing them", () => {
    const queue = new RequestPerformanceQueue(() => 0);
    queue.record({id:id(1),operation:"call.park",ms:180001,outcome:"timeout"});
    queue.record({id:id(2),operation:"call.park",ms:-1,outcome:"failed"});
    expect(queue.batch()).toEqual([expect.objectContaining({ms:180001,outcome:"timeout"})]);
    expect(queue.droppedCount()).toBe(1);
  });
  it("measures through body delivery and preserves the originating tab and responding deployment", async () => {
    vi.stubGlobal("window", {}); vi.stubEnv("NEXT_PUBLIC_DIAGNOSTICS_BUILD_ID", "tab_old");
    let now=100; vi.spyOn(performance,"now").mockImplementation(()=>now);
    const queue=requestPerformanceQueue(); queue.acknowledge(queue.batch(),queue.droppedCount());
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const response=new Response(new ReadableStream({start(controller){body=controller;}}),
      {headers:{"x-request-id":id(30),"x-app-version":"request_old"}});
    const pending=telephonyFetch("/api/telephony/calls/private/park",{method:"POST",timeoutMs:1000,label:"Čakáreň"},
      {fetch:vi.fn().mockResolvedValue(response)});
    await Promise.resolve(); expect(queue.batch()).toEqual([]);
    now=600; body.enqueue(new TextEncoder().encode('{}')); body.close(); await pending;
    const batch=queue.batch(); expect(batch).toEqual([expect.objectContaining({ms:500,clientBuild:"tab_old",requestBuild:"request_old",requestId:id(30)})]);
    expect(batch[0].startedAt).toMatch(/^\d{4}-/); expect(batch[0].completedAt).toMatch(/^\d{4}-/);
    queue.acknowledge(batch,0);
  });
  it("retains response correlation when headers arrive but the response body times out", async () => {
    vi.useFakeTimers(); vi.stubGlobal("window", {});
    const queue=requestPerformanceQueue(); queue.acknowledge(queue.batch(),queue.droppedCount());
    const response=new Response(new ReadableStream(),{headers:{"x-request-id":id(31),"x-app-version":"request_build"}});
    const pending=telephonyFetch("/api/telephony/calls/private/park",{method:"POST",timeoutMs:1000,label:"Čakáreň"},
      {fetch:vi.fn().mockResolvedValue(response)});
    const rejected=expect(pending).rejects.toBeInstanceOf(TelephonyRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(1000); await rejected;
    expect(queue.batch()).toEqual([expect.objectContaining({outcome:"timeout",status:200,requestId:id(31),requestBuild:"request_build"})]);
    queue.acknowledge(queue.batch(),0);
  });
  it("collects a request once, marks 202 as acceptance, and survives a failed telemetry clock", async () => {
    vi.stubGlobal("window", {});
    const queue = requestPerformanceQueue(); queue.acknowledge(queue.batch(), queue.droppedCount());
    await telephonyFetch("/api/telephony/calls/private/hangup", { method:"POST",timeoutMs:1000,label:"Položiť" }, { fetch:vi.fn().mockResolvedValue(Response.json({}, {status:202})) });
    expect(queue.batch()).toEqual([expect.objectContaining({operation:"call.hangup",outcome:"accepted",status:202})]);
    queue.acknowledge(queue.batch(),0);
    const done=beginRequestPerformance("/api/telephony/calls/private/hold","POST"); done({outcome:"timeout"}); done({outcome:"ok"});
    expect(queue.batch()).toHaveLength(1); expect(queue.batch()[0].outcome).toBe("timeout"); queue.acknowledge(queue.batch(),0);
    vi.spyOn(performance,"now").mockImplementation(()=>{throw Error("clock unavailable");});
    expect(()=>beginRequestPerformance("/api/telephony/calls/private/hold","POST")({outcome:"ok"})).not.toThrow();
  });
});
