import { describe, expect, it } from "vitest";
import { parseMobileConfig } from "./config";

const env = { environment: "test", apiUrl: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "sb_publishable_fixture" };
describe("mobile configuration isolation", () => {
  it("accepts only the explicit TEST target", () => { expect(parseMobileConfig(env).environment).toBe("test"); });
  it.each([
    { environment: undefined }, { apiUrl: "https://dispecing.linkapomoci.sk" },
    { apiUrl: "https://dispecing-test.vercel.app" }, { apiUrl: "http://test.dispecing.linkapomoci.sk" },
    { apiUrl: "https://user:password@test.dispecing.linkapomoci.sk" },
    { apiUrl: "https://test.dispecing.linkapomoci.sk?override=production" },
    { supabaseUrl: "https://ifpaeegaesdmljfkdvcn.supabase.co" },
    { supabaseUrl: "https://sjcsrygkkmersoczpunh.supabase.co" },
    { publishableKey: "sb_secret_forbidden" }, { publishableKey: "" },
  ])("rejects mismatched or unsafe config %j", changes => { expect(() => parseMobileConfig({ ...env, ...changes })).toThrow(); });
  it("accepts a matching anon key but rejects a service-role JWT", () => {
    const key = (role: string, ref: string) => "header." + btoa(JSON.stringify({ role, ref })) + ".signature";
    expect(parseMobileConfig({ ...env, publishableKey: key("anon", "nzpnqdstvkfncflgqlny") }).environment).toBe("test");
    expect(() => parseMobileConfig({ ...env, publishableKey: key("service_role", "nzpnqdstvkfncflgqlny") })).toThrow();
    expect(() => parseMobileConfig({ ...env, publishableKey: key("anon", "ifpaeegaesdmljfkdvcn") })).toThrow();
  });
  it("requires the full explicit production target", () => {
    expect(parseMobileConfig({ environment: "production", apiUrl: "https://dispecing.linkapomoci.sk", supabaseUrl: "https://ifpaeegaesdmljfkdvcn.supabase.co", publishableKey: "sb_publishable_fixture" }).environment).toBe("production");
  });
});
