import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppRole } from "@/domain/types";
import { MutationError } from "@/server/motorist-mutations";
import { ConfigServiceError, DEVICE_TAKEOVER_MESSAGE } from "@/server/telephony/config-service";
import { OperatorDeviceError } from "@/server/telephony/operator-devices";

/**
 * Role gating of `/api/telephony/operators/[id]/{settings,credential,disconnect}`.
 * Settings are self-service or manager/admin; credential and disconnect are
 * manager/admin only.
 */

/** Route ids must be uuids: `requireOperatorOfOrganization` rejects anything else. */
const PROFILE_1 = "11111111-1111-4111-8111-111111111111";
const PROFILE_2 = "22222222-2222-4222-8222-222222222222";

const state = { role: "dispatcher" as AppRole, profileId: PROFILE_1 };
const assertSameOriginRequest = vi.fn();
const updateOperatorTelephonySettings = vi.fn(async () => ({ defaultFromLineId: null, wrapUpSeconds: 45, autoAnswerOutbound: true, ringDeviceVolume: 80 }));
const auditOperatorDeviceAction = vi.fn(async () => undefined);
const requireOperatorOfOrganization = vi.fn(async (_deps: unknown, input: { profileId: string }) => ({ profileId: input.profileId, displayName: "Peter" }));
const assertOperatorNotOnCall = vi.fn(async () => undefined);
const ensureOperatorCredential = vi.fn(async () => ({ environment: "development", telnyx_credential_id: "cred-9", sip_username: "gencred009", registration_state: "registered" }));
const disconnectDevice = vi.fn(async () => ({ device: { environment: "development", registration_state: "unregistered" }, deletedCredentialId: "cred-8" }));
const getOperatorDevice = vi.fn(async () => ({ environment: "development", telnyx_credential_id: "cred-8", sip_username: "gencred008", registration_state: "registered" }));

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
    requireOperatorOfOrganization: (...args: unknown[]) => requireOperatorOfOrganization(...(args as unknown as [unknown, { profileId: string }])),
    assertOperatorNotOnCall: (...args: unknown[]) => assertOperatorNotOnCall(...(args as [])),
  };
});

vi.mock("@/server/telephony/operator-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/operator-devices")>();
  return {
    ...actual,
    ensureOperatorCredential: (...args: unknown[]) => ensureOperatorCredential(...(args as [])),
    disconnectDevice: (...args: unknown[]) => disconnectDevice(...(args as [])),
    getOperatorDevice: (...args: unknown[]) => getOperatorDevice(...(args as [])),
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
  state.profileId = PROFILE_1;
  process.env.TELNYX_API_KEY = "KEYtest";
  // `mockReset` (not `mockClear`): the CSRF test above installs a throwing
  // implementation that would otherwise leak into the next case.
  assertSameOriginRequest.mockReset();
  for (const mock of [updateOperatorTelephonySettings, auditOperatorDeviceAction, ensureOperatorCredential, disconnectDevice, getOperatorDevice, requireOperatorOfOrganization, assertOperatorNotOnCall]) {
    mock.mockClear();
  }
});

describe("PATCH /api/telephony/operators/[id]/settings", () => {
  it("lets an operator change their own settings", async () => {
    const response = await patchSettings(request(PROFILE_1, "PATCH", { patch: { wrapUpSeconds: 45 } }), context(PROFILE_1));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, profileId: PROFILE_1, settings: { wrapUpSeconds: 45 } });
    expect(updateOperatorTelephonySettings).toHaveBeenCalledWith({ admin: { marker: "admin" } }, expect.objectContaining({ profileId: PROFILE_1, patch: { wrapUpSeconds: 45 } }));
  });

  it("refuses a dispatcher changing somebody else's settings", async () => {
    const response = await patchSettings(request(PROFILE_2, "PATCH", { patch: { wrapUpSeconds: 45 } }), context(PROFILE_2));

    expect(response.status).toBe(403);
    expect(updateOperatorTelephonySettings).not.toHaveBeenCalled();
  });

  it("lets a manager change somebody else's settings", async () => {
    state.role = "manager";
    const response = await patchSettings(request(PROFILE_2, "PATCH", { patch: { autoAnswerOutbound: false } }), context(PROFILE_2));

    expect(response.status).toBe(200);
    expect(updateOperatorTelephonySettings).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ profileId: PROFILE_2 }));
  });

  it("runs the same-origin check first", async () => {
    assertSameOriginRequest.mockImplementation(() => {
      throw new MutationError("Požiadavka neprešla bezpečnostnou kontrolou.", 403);
    });
    const response = await patchSettings(request(PROFILE_1, "PATCH", { patch: {} }), context(PROFILE_1));

    expect(response.status).toBe(403);
    expect(updateOperatorTelephonySettings).not.toHaveBeenCalled();
  });
});

describe("POST /api/telephony/operators/[id]/credential", () => {
  it("is refused for a dispatcher", async () => {
    const response = await postCredential(request(PROFILE_2, "POST"), context(PROFILE_2));
    expect(response.status).toBe(403);
    expect(ensureOperatorCredential).not.toHaveBeenCalled();
  });

  it("provisions a credential for a manager without revoking the live session", async () => {
    state.role = "manager";
    const response = await postCredential(request(PROFILE_2, "POST"), context(PROFILE_2));

    expect(response.status).toBe(200);
    expect(ensureOperatorCredential).toHaveBeenCalledWith(expect.anything(), { organizationId: "org-1", profileId: PROFILE_2, force: false });
    expect(disconnectDevice).not.toHaveBeenCalled();
    expect(auditOperatorDeviceAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "credential.rotate", profileId: PROFILE_2 }));
  });

  it("regenerates and disconnects the browser on { rotate: true }", async () => {
    state.role = "admin";
    const response = await postCredential(request(PROFILE_2, "POST", { rotate: true }), context(PROFILE_2));

    expect(response.status).toBe(200);
    expect(ensureOperatorCredential).toHaveBeenCalledWith(expect.anything(), { organizationId: "org-1", profileId: PROFILE_2, force: true });
    // The rotate path only revokes the browser session; the credential it just
    // minted must survive (the superseded one is deleted inside
    // `ensureOperatorCredential`).
    expect(disconnectDevice).toHaveBeenCalledWith(expect.anything(), { organizationId: "org-1", profileId: PROFILE_2, keepCredential: true });
    await expect(response.json()).resolves.toMatchObject({ device: { registrationState: "unregistered" } });
    // The audit row names the credential that lost access, not only its replacement.
    expect(auditOperatorDeviceAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "credential.rotate", details: expect.objectContaining({ revokedCredentialId: "cred-8", credentialId: "cred-9" }) }),
    );
  });

  it("answers 503 while telephony is not configured", async () => {
    state.role = "manager";
    delete process.env.TELNYX_API_KEY;
    const response = await postCredential(request(PROFILE_2, "POST"), context(PROFILE_2));

    expect(response.status).toBe(503);
    expect(ensureOperatorCredential).not.toHaveBeenCalled();
  });

  it("refuses an id that is not an operator of the caller's organisation before touching Telnyx", async () => {
    state.role = "manager";
    requireOperatorOfOrganization.mockRejectedValueOnce(new ConfigServiceError("Operátor neexistuje alebo nie je aktívny v tejto organizácii.", 404, "operator_not_found") as never);
    const response = await postCredential(request(PROFILE_2, "POST"), context(PROFILE_2));

    expect(response.status).toBe(404);
    expect(ensureOperatorCredential).not.toHaveBeenCalled();
  });

  it("refuses to rotate while the operator is on a call unless the takeover is confirmed", async () => {
    state.role = "manager";
    assertOperatorNotOnCall.mockRejectedValueOnce(new ConfigServiceError(DEVICE_TAKEOVER_MESSAGE, 409, "operator_on_call") as never);
    const refused = await postCredential(request(PROFILE_2, "POST", { rotate: true }), context(PROFILE_2));

    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ code: "operator_on_call" });
    expect(ensureOperatorCredential).not.toHaveBeenCalled();

    const confirmed = await postCredential(request(PROFILE_2, "POST", { rotate: true, takeover: true }), context(PROFILE_2));
    expect(confirmed.status).toBe(200);
    expect(assertOperatorNotOnCall).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ takeover: true }));
  });
});

describe("POST /api/telephony/operators/[id]/disconnect", () => {
  it("is refused for a dispatcher", async () => {
    const response = await postDisconnect(request(PROFILE_2, "POST"), context(PROFILE_2));
    expect(response.status).toBe(403);
    expect(disconnectDevice).not.toHaveBeenCalled();
  });

  it("revokes the device session for a manager", async () => {
    state.role = "manager";
    const response = await postDisconnect(request(PROFILE_2, "POST"), context(PROFILE_2));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, profileId: PROFILE_2, registrationState: "unregistered", deletedCredentialId: "cred-8" });
    expect(auditOperatorDeviceAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "device.disconnect", details: expect.objectContaining({ deletedCredentialId: "cred-8" }) }),
    );
  });

  it("answers 404 when the operator has no device row", async () => {
    state.role = "manager";
    disconnectDevice.mockResolvedValueOnce(null as never);
    const response = await postDisconnect(request(PROFILE_2, "POST"), context(PROFILE_2));

    expect(response.status).toBe(404);
    expect(auditOperatorDeviceAction).not.toHaveBeenCalled();
  });

  it("maps a device service failure onto its own status", async () => {
    state.role = "manager";
    disconnectDevice.mockRejectedValueOnce(new OperatorDeviceError("Zariadenie sa nepodarilo odpojiť.", 500));
    const response = await postDisconnect(request(PROFILE_2, "POST"), context(PROFILE_2));

    expect(response.status).toBe(500);
  });

  it("reports a credential that Telnyx refused to delete as 502 (access is not revoked)", async () => {
    state.role = "manager";
    disconnectDevice.mockRejectedValueOnce(new OperatorDeviceError("Telefón sme odhlásili, ale prihlasovacie údaje sa nepodarilo zrušiť u operátora (cred-8). Prístup zatiaľ nie je odobratý.", 502));
    const response = await postDisconnect(request(PROFILE_2, "POST"), context(PROFILE_2));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("Prístup zatiaľ nie je odobratý") });
    expect(auditOperatorDeviceAction).not.toHaveBeenCalled();
  });

  it("refuses while the operator is on a call unless the takeover is confirmed", async () => {
    state.role = "manager";
    assertOperatorNotOnCall.mockRejectedValueOnce(new ConfigServiceError(DEVICE_TAKEOVER_MESSAGE, 409, "operator_on_call") as never);
    const refused = await postDisconnect(request(PROFILE_2, "POST"), context(PROFILE_2));

    expect(refused.status).toBe(409);
    expect(disconnectDevice).not.toHaveBeenCalled();

    const confirmed = await postDisconnect(request(PROFILE_2, "POST", { takeover: true }), context(PROFILE_2));
    expect(confirmed.status).toBe(200);
    expect(disconnectDevice).toHaveBeenCalledTimes(1);
  });
});
