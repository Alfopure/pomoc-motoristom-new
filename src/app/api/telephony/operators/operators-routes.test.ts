import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppRole } from "@/domain/types";
import { MutationError } from "@/server/motorist-mutations";
import { OperatorDeviceError } from "@/server/telephony/operator-devices";

/**
 * Role gating of `/api/telephony/operators/[id]/{settings,credential,disconnect}`.
 * Settings are self-service or manager/admin; credential and disconnect are
 * manager/admin only.
 */

const state = { role: "dispatcher" as AppRole, profileId: "profile-1" };
const assertSameOriginRequest = vi.fn();
const updateOperatorTelephonySettings = vi.fn(async () => ({ defaultFromLineId: null, wrapUpSeconds: 45, autoAnswerOutbound: true, ringDeviceVolume: 80 }));
const auditOperatorDeviceAction = vi.fn(async () => undefined);
const ensureOperatorCredential = vi.fn(async () => ({ environment: "development", telnyx_credential_id: "cred-9", sip_username: "gencred009", registration_state: "registered" }));
const disconnectDevice = vi.fn(async () => ({ environment: "development", registration_state: "unregistered" }));

vi.mock("@/server/api-auth", () => ({
  assertSameOriginRequest: (...args: unknown[]) => assertSameOriginRequest(...args),
  requireDefaultMotoristActor: async (roles: AppRole[] = ["manager", "admin"]) => {
    if (!roles.includes(state.role)) throw new MutationError("Nemáš oprávnenie na túto akciu.", 403);
    return { userId: "user-1", profileId: state.profileId, organizationId: "org-1", displayName: "Jana", role: state.role };
  },
}));

vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ marker: "admin" }) }));

vi.mock("@/server/telephony/config-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/config-service")>();
  return {
    ...actual,
    updateOperatorTelephonySettings: (...args: unknown[]) => updateOperatorTelephonySettings(...(args as [])),
    auditOperatorDeviceAction: (...args: unknown[]) => auditOperatorDeviceAction(...(args as [])),
  };
});

vi.mock("@/server/telephony/operator-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/operator-devices")>();
  return {
    ...actual,
    ensureOperatorCredential: (...args: unknown[]) => ensureOperatorCredential(...(args as [])),
    disconnectDevice: (...args: unknown[]) => disconnectDevice(...(args as [])),
  };
});

vi.mock("@/server/telephony/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/runtime")>();
  return { ...actual, createTelephonyDeps: async () => ({ admin: { marker: "admin" }, telnyx: { marker: "telnyx" }, environment: "development" }) };
});

import { PATCH as patchSettings } from "./[id]/settings/route";
import { POST as postCredential } from "./[id]/credential/route";
import { POST as postDisconnect } from "./[id]/disconnect/route";

function request(id: string, method: string, body: Record<string, unknown> = {}) {
  return new Request(`https://app.test/api/telephony/operators/${id}/settings`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  state.role = "dispatcher";
  state.profileId = "profile-1";
  process.env.TELNYX_API_KEY = "KEYtest";
  // `mockReset` (not `mockClear`): the CSRF test above installs a throwing
  // implementation that would otherwise leak into the next case.
  assertSameOriginRequest.mockReset();
  for (const mock of [updateOperatorTelephonySettings, auditOperatorDeviceAction, ensureOperatorCredential, disconnectDevice]) {
    mock.mockClear();
  }
});

describe("PATCH /api/telephony/operators/[id]/settings", () => {
  it("lets an operator change their own settings", async () => {
    const response = await patchSettings(request("profile-1", "PATCH", { patch: { wrapUpSeconds: 45 } }), context("profile-1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, profileId: "profile-1", settings: { wrapUpSeconds: 45 } });
    expect(updateOperatorTelephonySettings).toHaveBeenCalledWith({ admin: { marker: "admin" } }, expect.objectContaining({ profileId: "profile-1", patch: { wrapUpSeconds: 45 } }));
  });

  it("refuses a dispatcher changing somebody else's settings", async () => {
    const response = await patchSettings(request("profile-2", "PATCH", { patch: { wrapUpSeconds: 45 } }), context("profile-2"));

    expect(response.status).toBe(403);
    expect(updateOperatorTelephonySettings).not.toHaveBeenCalled();
  });

  it("lets a manager change somebody else's settings", async () => {
    state.role = "manager";
    const response = await patchSettings(request("profile-2", "PATCH", { patch: { autoAnswerOutbound: false } }), context("profile-2"));

    expect(response.status).toBe(200);
    expect(updateOperatorTelephonySettings).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ profileId: "profile-2" }));
  });

  it("runs the same-origin check first", async () => {
    assertSameOriginRequest.mockImplementation(() => {
      throw new MutationError("Požiadavka neprešla bezpečnostnou kontrolou.", 403);
    });
    const response = await patchSettings(request("profile-1", "PATCH", { patch: {} }), context("profile-1"));

    expect(response.status).toBe(403);
    expect(updateOperatorTelephonySettings).not.toHaveBeenCalled();
  });
});

describe("POST /api/telephony/operators/[id]/credential", () => {
  it("is refused for a dispatcher", async () => {
    const response = await postCredential(request("profile-2", "POST"), context("profile-2"));
    expect(response.status).toBe(403);
    expect(ensureOperatorCredential).not.toHaveBeenCalled();
  });

  it("provisions a credential for a manager without revoking the live session", async () => {
    state.role = "manager";
    const response = await postCredential(request("profile-2", "POST"), context("profile-2"));

    expect(response.status).toBe(200);
    expect(ensureOperatorCredential).toHaveBeenCalledWith(expect.anything(), { organizationId: "org-1", profileId: "profile-2", force: false });
    expect(disconnectDevice).not.toHaveBeenCalled();
    expect(auditOperatorDeviceAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "credential.rotate", profileId: "profile-2" }));
  });

  it("regenerates and disconnects the browser on { rotate: true }", async () => {
    state.role = "admin";
    const response = await postCredential(request("profile-2", "POST", { rotate: true }), context("profile-2"));

    expect(response.status).toBe(200);
    expect(ensureOperatorCredential).toHaveBeenCalledWith(expect.anything(), { organizationId: "org-1", profileId: "profile-2", force: true });
    expect(disconnectDevice).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({ device: { registrationState: "unregistered" } });
  });

  it("answers 503 while telephony is not configured", async () => {
    state.role = "manager";
    delete process.env.TELNYX_API_KEY;
    const response = await postCredential(request("profile-2", "POST"), context("profile-2"));

    expect(response.status).toBe(503);
    expect(ensureOperatorCredential).not.toHaveBeenCalled();
  });
});

describe("POST /api/telephony/operators/[id]/disconnect", () => {
  it("is refused for a dispatcher", async () => {
    const response = await postDisconnect(request("profile-2", "POST"), context("profile-2"));
    expect(response.status).toBe(403);
    expect(disconnectDevice).not.toHaveBeenCalled();
  });

  it("revokes the device session for a manager", async () => {
    state.role = "manager";
    const response = await postDisconnect(request("profile-2", "POST"), context("profile-2"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, profileId: "profile-2", registrationState: "unregistered" });
    expect(auditOperatorDeviceAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "device.disconnect" }));
  });

  it("answers 404 when the operator has no device row", async () => {
    state.role = "manager";
    disconnectDevice.mockResolvedValueOnce(null as never);
    const response = await postDisconnect(request("profile-2", "POST"), context("profile-2"));

    expect(response.status).toBe(404);
    expect(auditOperatorDeviceAction).not.toHaveBeenCalled();
  });

  it("maps a device service failure onto its own status", async () => {
    state.role = "manager";
    disconnectDevice.mockRejectedValueOnce(new OperatorDeviceError("Zariadenie sa nepodarilo odpojiť.", 500));
    const response = await postDisconnect(request("profile-2", "POST"), context("profile-2"));

    expect(response.status).toBe(500);
  });
});
