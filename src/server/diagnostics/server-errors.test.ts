import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callbacks = vi.hoisted(() => ({ after: vi.fn(), requestContext: vi.fn<() => { request_id: string; ingress_at: string } | null>() }));
vi.mock("next/server", () => ({ after: callbacks.after }));
vi.mock("@/server/request-metrics", () => ({ requestTimingContext: callbacks.requestContext }));
const host = "o4512180762640384.ingest.de.sentry.io";
const testDsn = `https://${"a".repeat(32)}@${host}/4512181071446096`;
const testEnv = {
  MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk",
  VERCEL_GIT_COMMIT_REF: "dev", VERCEL_GIT_COMMIT_SHA: "exact_release", APP_BASE_URL: "https://test.dispecing.linkapomoci.sk",
  SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co", SENTRY_PROJECT: "dispecing-test",
  DIAGNOSTICS_SERVER_SENTRY_DSN: testDsn, NEXT_PUBLIC_DIAGNOSTICS_SENTRY_DSN: testDsn, DIAGNOSTICS_SERVER_ERRORS_ENABLED: "true",
};
const eventId = "a".repeat(32);
function error(line = 12) {
  const result = new TypeError("private phone +421901123456 password=SECRET");
  result.stack = `TypeError: private phone\n at dangerousFunction (/var/task/.next/server/chunks/[root-of-the-server]__abc._.js:${line}:24)\n at dependency (/var/task/node_modules/private.js:2:3)\n at user (/secret/customer/private.js:1:1)`;
  return result;
}
function wire(request: unknown) {
  return String(request).trim().split("\n").map(line => JSON.parse(line));
}
beforeEach(() => {
  vi.resetModules(); callbacks.after.mockReset(); callbacks.requestContext.mockReset().mockReturnValue(null);
  for (const [key, value] of Object.entries(testEnv)) vi.stubEnv(key, value);
  vi.stubEnv("DEPLOYMENT_VERSION", "");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("explicit private server Sentry", () => {
  it("gates exact stable deployments and pins project/organization despite matching copied DSNs", async () => {
    const { serverSentryConfiguration: config } = await import("./server-errors");
    expect(config(testEnv)).toMatchObject({ environment: "test", release: "exact_release" });
    for (const patch of [{ VERCEL_ENV: "preview" }, { VERCEL_PROJECT_ID: "foreign" }, { VERCEL_GIT_COMMIT_REF: "feature" },
      { SENTRY_PROJECT: "sentry-beige-horizon" }, { SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co" },
      { DIAGNOSTICS_SERVER_SENTRY_DSN: testDsn.replace("4512181071446096", "4512180793638992"), NEXT_PUBLIC_DIAGNOSTICS_SENTRY_DSN: testDsn.replace("4512181071446096", "4512180793638992") },
      { DIAGNOSTICS_SERVER_SENTRY_DSN: testDsn.replace(host, "evil.example"), NEXT_PUBLIC_DIAGNOSTICS_SENTRY_DSN: testDsn.replace(host, "evil.example") }]) expect(config({ ...testEnv, ...patch })).toBeNull();
    const prodDsn = testDsn.replace("4512181071446096", "4512180793638992");
    const prod = { ...testEnv, MOTORIST_APP_ENV: "production", VERCEL_PROJECT_ID: "prj_DN3smSO1EbGowAmw3nHLQUYoSVJG", VERCEL_GIT_COMMIT_REF: "main",
      APP_BASE_URL: "https://dispecing.linkapomoci.sk", SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co", SENTRY_PROJECT: "sentry-beige-horizon",
      DIAGNOSTICS_SERVER_SENTRY_DSN: prodDsn, NEXT_PUBLIC_DIAGNOSTICS_SENTRY_DSN: prodDsn };
    expect(config(prod)?.environment).toBe("production");
    expect(config({ ...prod, VERCEL_PROJECT_ID: testEnv.VERCEL_PROJECT_ID })).toBeNull();
    expect(config({ ...prod, NEXT_PUBLIC_SUPABASE_URL: testEnv.SUPABASE_URL })).toBeNull();
  });

  it("keeps owned coordinates and closed technical codes, discarding arbitrary scopes and secrets", async () => {
    const { sanitizeServerError, sanitizeOutboundServerEvent } = await import("./server-errors");
    const input = Object.assign(error(), { code: "DIAGNOSTIC_TEST_CANARY" });
    const safe = sanitizeServerError(input, { source: "telephony", requestId: "11111111-1111-4111-8111-111111111111", route: "/api/calls/[id]/hold", status: 502 }, { release: "release", environment: "test" }, eventId)!;
    expect(safe.exception.values[0]).toEqual({ type: "TypeError", value: "TypeError: DIAGNOSTIC_TEST_CANARY", stacktrace: { frames: [{ filename: "app:///server/chunks/[root-of-the-server]__abc._.js", abs_path: "app:///server/chunks/[root-of-the-server]__abc._.js", lineno: 12, colno: 24, in_app: true }] } });
    const outbound = sanitizeOutboundServerEvent({ ...safe, request: { headers: { authorization: "SECRET" } }, user: { email: "private@example.test" }, contexts: { runtime: "PRIVATE" }, extra: { token: "SECRET" }, breadcrumbs: ["SECRET"], server_name: "PRIVATE" });
    expect(outbound).toEqual(safe);
    expect(JSON.stringify(outbound)).not.toMatch(/SECRET|421901|dangerousFunction|node_modules|private@example/);
    expect(sanitizeServerError(Object.assign(error(), { code: "customer_private_value" }), { route: "/api/call?phone=SECRET" }, { release: "release", environment: "test" })?.tags).not.toHaveProperty("error_code");
  });

  it("does not invoke arbitrary rejection or Error accessors", async () => {
    const { sanitizeServerError } = await import("./server-errors");
    const getter = vi.fn(() => { throw new Error("must not run"); });
    const forged = Object.defineProperties({}, { name: { get: getter }, stack: { get: getter }, code: { get: getter } });
    expect(sanitizeServerError(forged, {}, { release: "release", environment: "test" })?.exception.values[0].type).toBe("UnknownError");
    expect(getter).not.toHaveBeenCalled();
  });

  it("real LightNodeClient delivers one sanitized event and requires HTTP ACK", async () => {
    const { captureServerError } = await import("./server-errors");
    const receipt = await captureServerError(error(), { source: "telephony", status: 502 });
    expect(receipt.accepted).toBe(true);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    const sent = wire(init?.body);
    expect(sent[1]).toEqual({ type: "event" });
    expect(sent[2].event_id).toBe(receipt.eventId);
    expect(sent[2].environment).toBe("test");
    expect(Object.keys(sent[0])).toEqual(["event_id"]);
    expect(JSON.stringify(sent)).not.toMatch(/SECRET|421901|request|sdk|server_name/);
    vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 503 }));
    expect((await captureServerError(error(13))).accepted).toBe(false);
  });

  it("real SDK check-ins preserve IDs/status but strip ambient scope and monitor config", async () => {
    const sdk = await import("@sentry/node-core/light");
    sdk.getGlobalScope().setTag("private", "SECRET");
    try {
      const { getServerSentryClient } = await import("./server-errors");
      const active = (await getServerSentryClient())!;
      const id = active.captureCheckIn({ monitorSlug: "test-cron", status: "in_progress" }, { schedule: { type: "crontab", value: "* * * * *" } });
      await active.flush(1000);
      active.captureCheckIn({ checkInId: id, monitorSlug: "test-cron", status: "ok", duration: 0.25 });
      await active.flush(1000);
      expect(fetch).toHaveBeenCalledTimes(2);
      const events = vi.mocked(fetch).mock.calls.map(([, init]) => wire(init?.body));
      expect(events.map(event => event[2].check_in_id)).toEqual([id, id]);
      expect(events.map(event => event[2].status)).toEqual(["in_progress", "ok"]);
      for (const event of events) {
        expect(event[1]).toEqual({ type: "check_in" });
        expect(event[2]).toMatchObject({ environment: "test", release: "exact_release" });
        expect(JSON.stringify(event)).not.toMatch(/SECRET|trace|contexts|monitor_config|sdk/);
      }
    } finally { sdk.getGlobalScope().clear(); }
  });

  it("joins an existing owned request context without trusting inbound headers", async () => {
    callbacks.requestContext.mockReturnValue({ request_id: "11111111-1111-4111-8111-111111111111", ingress_at: "PRIVATE_UNUSED" });
    const { captureServerError } = await import("./server-errors");
    expect((await captureServerError(error(), { source: "next" })).accepted).toBe(true);
    const sent = wire(vi.mocked(fetch).mock.calls[0][1]?.body);
    expect(sent[2].tags.request_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(JSON.stringify(sent)).not.toContain("PRIVATE_UNUSED");
  });

  it("aborts a hung transport and reports no false acknowledgement", async () => {
    vi.mocked(fetch).mockImplementation((_url, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })));
    const { captureServerError } = await import("./server-errors");
    const start = Date.now();
    expect((await captureServerError(error())).accepted).toBe(false);
    expect(Date.now() - start).toBeLessThan(2200);
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("defers caught errors without importing or sending on the business path", async () => {
    const { deferServerError } = await import("./server-errors");
    deferServerError(error(), { source: "telephony" });
    expect(callbacks.after).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    await callbacks.after.mock.calls[0][0]();
    expect(fetch).toHaveBeenCalledOnce();
    callbacks.after.mockImplementation(() => { throw new Error("outside lifecycle"); });
    expect(() => deferServerError(error())).not.toThrow();
  });

  it("deduplicates a storm and bounds distinct errors per warm instance", async () => {
    const { captureServerError } = await import("./server-errors");
    const first = await captureServerError(error());
    expect((await captureServerError(error())).eventId).toBe(first.eventId);
    expect(fetch).toHaveBeenCalledOnce();
    for (let line = 100; line < 112; line++) await captureServerError(error(line));
    expect(fetch).toHaveBeenCalledTimes(10);
  });
});
