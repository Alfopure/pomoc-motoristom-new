import { afterEach, expect, it, vi } from "vitest";
import { logRequestPerformance } from "./request-performance";
const entry = {id:"00000000-0000-4000-8000-000000000001",operation:"call.park",ms:1250,outcome:"ok",phone:"private"};
afterEach(()=>vi.unstubAllEnvs());
it("logs without a database and uses TEST app identity even on the Vercel Production target",()=>{
  vi.stubEnv("MOTORIST_APP_ENV","test"); vi.stubEnv("VERCEL_ENV","production");
  const logger=vi.fn(); expect(logRequestPerformance([entry],2,logger)).toEqual({performanceIds:[entry.id],performanceDropped:2});
  expect(logger.mock.calls[0][0]).toMatchObject({scope:"call-request-performance",environment:"test",sampleRate:1,measurement:"request_roundtrip",operation:"call.park"});
  expect(JSON.stringify(logger.mock.calls)).not.toContain("private");
});
it("does not acknowledge a rejected sink or turn it into a call error",()=>{
  const logger=vi.fn(()=>{throw Error("sink failed");});
  expect(logRequestPerformance([entry],2,logger)).toEqual({performanceIds:[],performanceDropped:0});
});
