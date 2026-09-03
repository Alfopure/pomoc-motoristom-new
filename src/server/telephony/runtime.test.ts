import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TelephonyNotConfiguredError } from "@/lib/telephony/not-configured";
import { MutationError } from "@/server/motorist-mutations";
import { createTelephonyHarness, ORG } from "@/test/telephony-harness";

import { CallActionError } from "./call-actions";
import { OperatorDeviceError } from "./operator-devices";
import { PresenceServiceError } from "./presence-service";
import { TelnyxCommandError } from "./telnyx/client";

let harness: ReturnType<typeof createTelephonyHarness>;

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
    process.env.TELNYX_API_KEY = "KEYtest";
    process.env.TELNYX_LIVE_CALLS_ENABLED = "true";
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
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
    await expect(notConfiguredResponse().json()).resolves.toEqual({ error: "Telefónia nie je nakonfigurovaná." });
  });

  it("skips the organisation lookup when the caller already resolved it", async () => {
    const deps = await createTelephonyDeps({ organizationId: "org-override" });
    expect(deps.organizationId).toBe("org-override");
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
