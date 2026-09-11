import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TelephonyNotConfiguredError } from "@/lib/telephony/not-configured";
import { MutationError } from "@/server/motorist-mutations";
import { createTelephonyHarness, ORG } from "@/test/telephony-harness";

import { CallActionError } from "./call-actions";
import { OperatorDeviceError } from "./operator-devices";
import { PresenceServiceError } from "./presence-service";
import { TelnyxCommandError } from "./telnyx/client";

let harness: ReturnType<typeof createTelephonyHarness>;
const notifications = vi.hoisted(() => ({ after: vi.fn(), notify: vi.fn() }));

vi.mock("next/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("next/server")>(), after: notifications.after,
}));
vi.mock("./call-notifications", () => ({ notifyCallState: notifications.notify }));

vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => harness.admin }));
vi.mock("@/server/default-organization", () => ({ resolveDefaultOrganizationId: async () => ORG }));

import {
  createTelephonyDeps,
  isProductionDeployment,
  notConfiguredResponse,
  readJsonBody,
  readString,
  telephonyConfiguredOrResponse,
  telephonyEnvironment,
  telephonyErrorResponse,
  toCallActor,
} from "./runtime";

describe("telephony runtime", () => {
  beforeEach(() => {
    harness = createTelephonyHarness();
    notifications.after.mockReset();
    notifications.notify.mockReset().mockResolvedValue({ sent: 0, failed: 0 });
    process.env.TELNYX_API_KEY = "KEYtest";
    process.env.TELNYX_LIVE_CALLS_ENABLED = "true";
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_LIVE_CALLS_ENABLED;
    delete process.env.VERCEL_ENV;
  });

  it("treats only the Vercel production deployment as the production environment", () => {
    expect(telephonyEnvironment({ VERCEL_ENV: "production" })).toBe("production");
    expect(telephonyEnvironment({ VERCEL_ENV: "preview", NODE_ENV: "production" })).toBe("development");
    expect(telephonyEnvironment({})).toBe("development");
    expect(isProductionDeployment({ VERCEL_ENV: "preview" })).toBe(false);
  });

  it("builds deps with a client whose live gate ANDs the env switch with the DB switch", async () => {
    const deps = await createTelephonyDeps();

    expect(deps.organizationId).toBe(ORG);
    expect(deps.environment).toBe("development");
    expect(deps.telnyx?.liveGate).toEqual({ callsEnabled: true, smsEnabled: false });
  });

  it("logs provider HTTP timing with sanitized identifiers through the runtime logger", async () => {
    const logger = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { result: "ok" } }), {
      status: 200, headers: { "content-type": "application/json" },
    })));
    const deps = await createTelephonyDeps({ logger });
    const commandId = "bb824028-87c9-442f-bfac-ac527f733493";
    await deps.telnyx!.bridge({ callControlId: "PRIVATE_CALL_CONTROL_TOKEN", targetCallControlId: "PRIVATE_TARGET_TOKEN", commandId });
    expect(logger).toHaveBeenCalledExactlyOnceWith({ scope: "telnyx-http", level: "info", method: "POST", path: "/calls/:id/actions/bridge",
      commandId, status: 200, ms: expect.any(Number), retried: false, errorCode: null });
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(/PRIVATE_|KEYtest/);
  });

  it("keeps accepted provider commands successful when the runtime logger throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"data":{"result":"ok"}}', { status: 200 })));
    const deps = await createTelephonyDeps({ logger: () => { throw new Error("logger failed"); } });
    await expect(deps.telnyx!.answer({ callControlId: "PRIVATE_CALL_CONTROL_TOKEN", commandId: "bb824028-87c9-442f-bfac-ac527f733493" })).resolves.toBeUndefined();
  });

  it("fails the live gate closed when the settings row switches calls off", async () => {
    harness.db.update("motorist_telephony_settings", { live_calls_enabled: false }, () => true);

    const deps = await createTelephonyDeps();
    expect(deps.telnyx?.liveGate.callsEnabled).toBe(false);
  });

  it("returns a null client (never throws) when telephony is not configured", async () => {
    delete process.env.TELNYX_API_KEY;

    const deps = await createTelephonyDeps();
    expect(deps.telnyx).toBeNull();
    expect(deps.config.configured).toBe(false);
    expect(telephonyConfiguredOrResponse(deps.config)?.status).toBe(503);
    await expect(notConfiguredResponse().json()).resolves.toEqual({ error: "Telefónia nie je nakonfigurovaná.", code: "not_configured" });
  });

  it("skips the organisation lookup when the caller already resolved it", async () => {
    const deps = await createTelephonyDeps({ organizationId: "org-override" });
    expect(deps.organizationId).toBe("org-override");
  });

  it("defers call push until after the response and coalesces the same session within a request", async () => {
    const deps = await createTelephonyDeps();
    deps.onCallTransition?.("session-1");
    deps.onCallTransition?.("session-1");
    expect(notifications.after).toHaveBeenCalledTimes(1);
    expect(notifications.notify).not.toHaveBeenCalled();
    await notifications.after.mock.calls[0][0]();
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ admin: harness.admin, organizationId: ORG, environment: "development", deadlineAt: expect.any(Number) }), "session-1");
  });

  it("caps queued sessions at three concurrent deliveries and lets other calls continue after a failure", async () => {
    const deps = await createTelephonyDeps({ logger: vi.fn() });
    let active = 0;
    let maximum = 0;
    const pending: Array<{ resolve: () => void; reject: () => void }> = [];
    notifications.notify.mockImplementation(() => {
      active++;
      maximum = Math.max(maximum, active);
      return new Promise((resolve, reject) => pending.push({
        resolve: () => { active--; resolve({ sent: 1, failed: 0 }); },
        reject: () => { active--; reject(new Error("delivery failed")); },
      }));
    });
    for (let index = 0; index < 7; index++) deps.onCallTransition?.(`session-${index}`);
    expect(notifications.after).toHaveBeenCalledTimes(1);
    const work = notifications.after.mock.calls[0][0]();
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    pending[0].reject();
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    pending[1].resolve();
    pending[2].resolve();
    pending[3].resolve();
    await vi.waitFor(() => expect(pending).toHaveLength(7));
    pending.slice(4).forEach((delivery) => delivery.resolve());
    await work;
    expect(maximum).toBe(3);
    expect(notifications.notify).toHaveBeenCalledTimes(7);
  });

  it("stops starting queued sessions at the shared deadline without claiming skipped notifications", async () => {
    const logger = vi.fn();
    const deps = await createTelephonyDeps({ logger });
    let clock = 1_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => clock);
    notifications.notify.mockImplementation(async ({ deadlineAt }: { deadlineAt: number }) => {
      clock = deadlineAt + 1;
      return { sent: 0, failed: 0 };
    });
    try {
      for (let index = 0; index < 5; index++) deps.onCallTransition?.(`session-${index}`);
      await notifications.after.mock.calls[0][0]();
      expect(notifications.notify).toHaveBeenCalledTimes(1);
      expect(logger).toHaveBeenCalledWith({ level: "warn", scope: "call-push", message: "notification queue budget reached", skipped: 4 });
    } finally { dateNow.mockRestore(); }
  });

  it("isolates scheduling and delivery errors from the telephony request", async () => {
    const logger = vi.fn();
    const deps = await createTelephonyDeps({ logger });
    notifications.after.mockImplementationOnce(() => { throw new Error("no request context"); });
    expect(() => deps.onCallTransition?.("session-1")).not.toThrow();
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({ scope: "call-push", message: "notification scheduling unavailable" }));
    deps.onCallTransition?.("session-1");
    notifications.notify.mockRejectedValueOnce(new Error("provider failure with credentials"));
    await expect(notifications.after.mock.calls[1][0]()).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({ scope: "call-push", message: "notification delivery unavailable" }));
    expect(JSON.stringify(logger.mock.calls)).not.toContain("credentials");
  });

  it("maps every service error class onto its HTTP status", async () => {
    const cases: Array<[unknown, number]> = [
      [new MutationError("nope", 401), 401],
      [new CallActionError("busy", 409, "operator_busy"), 409],
      [new PresenceServiceError("na hovore", 409), 409],
      [new OperatorDeviceError("nope", 503), 503],
      [new TelephonyNotConfiguredError(), 503],
      [new TelnyxCommandError({ code: "timeout", status: 504 }), 502],
      [new TelnyxCommandError({ code: "live_calls_disabled", status: 423 }), 423],
    ];
    for (const [error, status] of cases) {
      expect(telephonyErrorResponse(error, "fallback").status, String(error)).toBe(status);
    }

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const unexpected = telephonyErrorResponse(new Error("boom"), "Akcia zlyhala.");
    expect(unexpected.status).toBe(500);
    await expect(unexpected.json()).resolves.toEqual({ error: "Akcia zlyhala." });
    consoleError.mockRestore();
  });

  it("reads request bodies tolerantly", async () => {
    await expect(readJsonBody(new Request("https://app.test", { method: "POST", body: "not json" }))).resolves.toEqual({});
    await expect(readJsonBody(new Request("https://app.test", { method: "POST", body: "[1,2]" }))).resolves.toEqual({});
    await expect(readJsonBody(new Request("https://app.test", { method: "POST", body: '{"a":1}' }))).resolves.toEqual({ a: 1 });
    expect(readString("  x  ")).toBe("x");
    expect(readString("   ")).toBeNull();
    expect(readString(42)).toBeNull();
  });

  it("narrows the session actor to the call-action shape", () => {
    expect(toCallActor({ userId: "u", profileId: "p", organizationId: "o", displayName: "Jana", role: "manager", email: "a@b.c" })).toEqual({
      profileId: "p",
      role: "manager",
      displayName: "Jana",
    });
  });
});
