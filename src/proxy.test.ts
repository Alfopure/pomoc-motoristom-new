import { readdirSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ssr = vi.hoisted(() => ({ createServerClient: vi.fn() }));
vi.mock("@supabase/ssr", () => ssr);

import { config } from "./proxy";
import { hasSupabaseSessionCookie, updateSession } from "./lib/supabase/proxy";

const APP = path.resolve(__dirname, "app");
/** URL paths of every `page.tsx` / `route.ts(x)` file under a directory, dynamic segments filled in. */
function routes(dir: string, file: RegExp): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter(entry => file.test(path.basename(entry)))
    .map(entry => "/" + path.dirname(entry).split(path.sep).filter(part => part !== ".").map(part => part.replace(/^\[{1,2}\.{0,3}(.+?)\]{1,2}$/, "x-$1")).join("/"))
    .map(url => url === "/" ? url : url.replace(/\/$/, ""));
}
const runs = (url: string, headers?: Record<string, string>) => unstable_doesMiddlewareMatch({ config, url, headers });

describe("proxy matcher", () => {
  it("runs on every page, including RSC and Server Function requests", () => {
    const pages = routes(APP, /^page\.tsx$/);
    expect(pages).toEqual(expect.arrayContaining(["/", "/pobocka", "/zakazky", "/navod/x-slug", "/l/x-token", "/auth/set-password"]));
    for (const page of pages) expect(runs(page), page).toBe(true);
    expect(runs("/?_rsc=abc", { rsc: "1" })).toBe(true);
    expect(runs("/pobocka", { "next-action": "abc" })).toBe(true);
    // App Router transport forms of the same page.
    for (const url of ["/pobocka.rsc", "/pobocka.segments/_tree.segment.rsc", "/index.rsc", "/navod/x-slug.rsc"]) expect(runs(url), url).toBe(true);
  });

  it("never runs on an API route: webhooks, cron, bearer, mobile, public or session", () => {
    const api = routes(path.join(APP, "api"), /^route\.tsx?$/).map(url => "/api" + (url === "/" ? "" : url));
    expect(api).toEqual(expect.arrayContaining(["/api/telephony/telnyx/webhook", "/api/sms/telnyx/webhook", "/api/telephony/cron", "/api/mobile/v1/me",
      "/api/public/handoffs/session", "/api/pobocky"]));
    for (const route of [...api, "/api", "/api/mobile/v1/field/branch?view=open"]) expect(runs(route), route).toBe(false);
  });

  it("skips Next internals, the auth callback, icons and files", () => {
    for (const url of ["/_next/static/chunks/app.js", "/_next/image?url=%2Fx.png&w=64&q=75", "/_next/webpack-hmr", "/auth/callback?code=abc", "/icon", "/icon-192", "/apple-icon",
      "/favicon.ico", "/sw.js", "/workplace-heartbeat-worker.js", "/manifest.webmanifest", "/vodic.webmanifest", "/guide-assets/cases.webp", "/telephony/ring.mp3",
      "/telephony/announcements-v4/manifest.json", "/telephony/README.md", "/file.svg", "/robots.txt", "/sitemap.xml"]) {
      expect(runs(url), url).toBe(false);
    }
  });
});

describe("updateSession", () => {
  const SESSION = "sb-nzpnqdstvkfncflgqlny-auth-token";
  const request = (cookie?: string) => new NextRequest("https://test.dispecing.linkapomoci.sk/pobocka", cookie ? { headers: { cookie } } : undefined);
  const passesThrough = (response: Response) => {
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
  };

  beforeEach(() => {
    vi.stubEnv("SUPABASE_URL", "https://nzpnqdstvkfncflgqlny.supabase.co");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    ssr.createServerClient.mockReset();
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("recognizes only session cookies, chunked or not", () => {
    expect(hasSupabaseSessionCookie(request(`${SESSION}=x`))).toBe(true);
    expect(hasSupabaseSessionCookie(request(`${SESSION}.0=x; ${SESSION}.1=y`))).toBe(true);
    expect(hasSupabaseSessionCookie(request(`${SESSION}-code-verifier=x`))).toBe(false);
    expect(hasSupabaseSessionCookie(request("motorist_handoff=x; theme=light"))).toBe(false);
    expect(hasSupabaseSessionCookie(request())).toBe(false);
  });

  it("leaves anonymous requests alone without contacting Supabase", async () => {
    const response = await updateSession(request("motorist_handoff=x"));
    passesThrough(response);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-middleware-override-headers")).toBeNull();
    expect(ssr.createServerClient).not.toHaveBeenCalled();
  });

  it("writes a refreshed session to the rendered request and the browser", async () => {
    ssr.createServerClient.mockImplementation((url: string, key: string, options: { cookies: { getAll(): { name: string }[]; setAll(cookies: unknown[], headers: Record<string, string>): void } }) => {
      expect([url, key]).toEqual(["https://nzpnqdstvkfncflgqlny.supabase.co", "sb_publishable_test"]);
      return { auth: { getClaims: vi.fn(async () => {
        expect(options.cookies.getAll().map(cookie => cookie.name)).toEqual([SESSION]);
        options.cookies.setAll([{ name: SESSION, value: "fresh", options: { path: "/", sameSite: "lax", maxAge: 400 * 24 * 3600 } }], { "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0" });
        return { data: { claims: { sub: "u" } }, error: null };
      }) } };
    });
    const response = await updateSession(request(`${SESSION}=stale`));
    passesThrough(response);
    expect(ssr.createServerClient).toHaveBeenCalledTimes(1);
    expect(response.headers.get("set-cookie")).toContain(`${SESSION}=fresh`);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-middleware-request-cookie")).toBe(`${SESSION}=fresh`);
  });

  it("does not touch cookies when the session is still valid", async () => {
    ssr.createServerClient.mockReturnValue({ auth: { getClaims: vi.fn(async () => ({ data: { claims: { sub: "u" } }, error: null })) } });
    const response = await updateSession(request(`${SESSION}=valid`));
    passesThrough(response);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-middleware-override-headers")).toBeNull();
  });

  it("never blocks when Auth fails or the environment is unusable", async () => {
    ssr.createServerClient.mockReturnValue({ auth: { getClaims: vi.fn(async () => { throw new Error("network"); }) } });
    passesThrough(await updateSession(request(`${SESSION}=stale`)));

    ssr.createServerClient.mockClear();
    vi.stubEnv("SUPABASE_URL", "https://sjcsrygkkmersoczpunh.supabase.co");
    passesThrough(await updateSession(request(`${SESSION}=stale`)));
    expect(ssr.createServerClient).not.toHaveBeenCalled();

    vi.stubEnv("SUPABASE_URL", "");
    passesThrough(await updateSession(request(`${SESSION}=stale`)));
    expect(ssr.createServerClient).not.toHaveBeenCalled();
  });
});
