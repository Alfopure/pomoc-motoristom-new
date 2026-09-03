import { beforeEach, describe, expect, it, vi } from "vitest";

import { MutationError } from "@/server/motorist-mutations";
import type { AppRole } from "@/domain/types";

/**
 * Role gating and wiring of the `/api/telephony/config/*` routes
 * (pattern: `src/app/api/auth/forgot-password/route.test.ts` — the service is
 * mocked, only the route contract is under test).
 *
 * `requireDefaultMotoristActor` is mocked with a faithful role check so a route
 * that forgets its role list fails here.
 */

const state = { role: "manager" as AppRole };
const assertSameOriginRequest = vi.fn();

vi.mock("@/server/api-auth", () => ({
  assertSameOriginRequest: (...args: unknown[]) => assertSameOriginRequest(...args),
  requireDefaultMotoristActor: async (roles: AppRole[] = ["manager", "admin"]) => {
    if (!roles.includes(state.role)) throw new MutationError("Nemáš oprávnenie na túto akciu.", 403);
    return { userId: "user-1", profileId: "profile-1", organizationId: "org-1", displayName: "Manažér", role: state.role };
  },
}));

vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ marker: "admin" }) }));

const document = {
  organizationId: "org-1",
  routingVersion: 7,
  groups: [],
  plans: [],
  businessHours: [],
  pauseReasons: [],
  pauseReasonsInUse: [],
  lines: [{ id: "line-1", phoneNumber: "+421232408700", label: "Hlavná linka" }],
  ivrMenus: [],
  operators: [
    { profileId: "profile-1", displayName: "Manažér", role: "manager", active: true, settings: null, device: { environment: "development", credentialId: "cred-1", sipUsername: "gencred001", registrationState: "registered", deviceSeenAt: null } },
    { profileId: "profile-2", displayName: "Kolega", role: "dispatcher", active: true, settings: null, device: { environment: "development", credentialId: "cred-2", sipUsername: "gencred002", registrationState: "registered", deviceSeenAt: null } },
  ],
  limits: { destinationAllowlist: ["SK"], maxRingFanout: 8, maxConcurrentLegs: 9 },
  settings: { liveCallsEnabled: true, smsLiveSends: false, dailyLegSoftCap: 500, parkMaxMinutes: 30, destinationAllowlist: ["SK"], maxRingFanout: 8, maxConcurrentLegs: 9 },
};

const getRoutingDocument = vi.fn(async () => document);
const replaceRingGroups = vi.fn(async () => ({ document, diff: { added: [], removed: [], changed: [] }, warning: null }));
const replaceRingPlans = vi.fn(async () => ({ document, diff: { added: [], removed: [], changed: [] }, warning: null }));
const replaceBusinessHours = vi.fn(async () => ({ document, diff: { added: [], removed: [], changed: [] }, warning: null }));
const replacePauseReasons = vi.fn(async () => ({ document, diff: { added: [], removed: [], changed: [] }, warning: null }));
const replaceIvrMenus = vi.fn(async () => ({ document, diff: { added: [], removed: [], changed: [] }, warning: null }));
const updateTelephonyLine = vi.fn(async () => ({ document, line: document.lines[0] }));
const updateTelephonySettings = vi.fn(async () => ({ settings: document.settings, warning: null }));

vi.mock("@/server/telephony/config-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/config-service")>();
  return {
    ...actual,
    getRoutingDocument: (...args: unknown[]) => getRoutingDocument(...(args as [])),
    replaceRingGroups: (...args: unknown[]) => replaceRingGroups(...(args as [])),
    replaceRingPlans: (...args: unknown[]) => replaceRingPlans(...(args as [])),
    replaceBusinessHours: (...args: unknown[]) => replaceBusinessHours(...(args as [])),
    replacePauseReasons: (...args: unknown[]) => replacePauseReasons(...(args as [])),
    replaceIvrMenus: (...args: unknown[]) => replaceIvrMenus(...(args as [])),
    updateTelephonyLine: (...args: unknown[]) => updateTelephonyLine(...(args as [])),
    updateTelephonySettings: (...args: unknown[]) => updateTelephonySettings(...(args as [])),
  };
});

import { ConfigServiceError } from "@/server/telephony/config-service";

import { GET as getGroups, PUT as putGroups } from "./ring-groups/route";
import { GET as getPlans, PUT as putPlans } from "./ring-plans/route";
import { PUT as putHours } from "./business-hours/route";
import { PUT as putReasons } from "./pause-reasons/route";
import { GET as getIvrMenus, PUT as putIvrMenus } from "./ivr-menus/route";
import { GET as getNumbers, PATCH as patchNumbers } from "./numbers/route";
import { GET as getSettings, PATCH as patchSettings } from "./settings/route";

function request(path: string, method: string, body: Record<string, unknown> = {}) {
  return new Request(`https://app.test/api/telephony/config/${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const VALID_GROUPS = [{ id: "00000000-0000-4000-8000-000000000001", name: "Dispečing A", members: [{ memberKind: "operator", profileId: "00000000-0000-4000-8000-000000000101", position: 0 }] }];

beforeEach(() => {
  state.role = "manager";
  assertSameOriginRequest.mockReset();
  for (const mock of [getRoutingDocument, replaceRingGroups, replaceRingPlans, replaceBusinessHours, replacePauseReasons, replaceIvrMenus, updateTelephonyLine, updateTelephonySettings]) {
    mock.mockClear();
  }
});

describe("GET /api/telephony/config/*", () => {
  it("serves the routing document to a dispatcher without the settings, the limits or a colleague's SIP identity", async () => {
    state.role = "dispatcher";
    const response = await getGroups();

    expect(response.status).toBe(200);
    const body = (await response.json()) as { canEdit: boolean; document: typeof document };
    expect(body).toMatchObject({ canEdit: false, canManageSettings: false });
    expect(body.document.settings).toBeNull();
    expect(body.document.limits).toBeNull();
    // Own row keeps its device; every colleague's Telnyx credential and SIP user is stripped.
    expect(body.document.operators.find((operator) => operator.profileId === "profile-1")?.device).not.toBeNull();
    expect(body.document.operators.find((operator) => operator.profileId === "profile-2")?.device).toBeNull();
    expect(getRoutingDocument).toHaveBeenCalledWith(
      { admin: { marker: "admin" } },
      { organizationId: "org-1", includeSettings: false, includeLimits: false, includeOperatorDetails: false, viewerProfileId: "profile-1" },
    );
  });

  it("gives a manager the routing limits but never the admin-only kill switches", async () => {
    const response = await getPlans();

    const body = (await response.json()) as { canEdit: boolean; document: typeof document };
    expect(body).toMatchObject({ canEdit: true, canManageSettings: false });
    // A manager is refused GET /config/settings, so the same fields must not
    // arrive through this response either.
    expect(body.document.settings).toBeNull();
    expect(body.document.limits).toEqual({ destinationAllowlist: ["SK"], maxRingFanout: 8, maxConcurrentLegs: 9 });
    expect(body.document.operators.find((operator) => operator.profileId === "profile-2")?.device).not.toBeNull();
    expect(getRoutingDocument).toHaveBeenCalledWith(expect.anything(), {
      organizationId: "org-1",
      includeSettings: false,
      includeLimits: true,
      includeOperatorDetails: true,
      viewerProfileId: "profile-1",
    });
  });

  it("gives an admin the whole settings row", async () => {
    state.role = "admin";
    const body = (await (await getPlans()).json()) as { document: typeof document };
    expect(body.document.settings).toMatchObject({ liveCallsEnabled: true, dailyLegSoftCap: 500 });
  });

  it("keeps the numbers panel readable for every member", async () => {
    state.role = "senior_dispatcher";
    expect((await getNumbers()).status).toBe(200);
  });

  it("refuses the organisation settings to everybody but an admin", async () => {
    state.role = "manager";
    expect((await getSettings()).status).toBe(403);

    state.role = "admin";
    const response = await getSettings();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ canManageSettings: true });
  });
});

describe("PUT/PATCH /api/telephony/config/*", () => {
  it("replaces ring groups for a manager and returns the fresh document", async () => {
    const response = await putGroups(request("ring-groups", "PUT", { groups: VALID_GROUPS, version: document.routingVersion }));

    expect(response.status).toBe(200);
    expect(assertSameOriginRequest).toHaveBeenCalledTimes(1);
    expect(replaceRingGroups).toHaveBeenCalledWith(
      { admin: { marker: "admin" } },
      expect.objectContaining({ organizationId: "org-1", actor: { profileId: "profile-1", role: "manager", displayName: "Manažér" }, expectedVersion: 7 }),
    );
    await expect(response.json()).resolves.toMatchObject({ canEdit: true });
  });

  it("refuses every write from a dispatcher", async () => {
    state.role = "dispatcher";
    const responses = await Promise.all([
      putGroups(request("ring-groups", "PUT", { groups: [], version: document.routingVersion })),
      putPlans(request("ring-plans", "PUT", { plans: [], version: document.routingVersion })),
      putHours(request("business-hours", "PUT", { businessHours: [], version: document.routingVersion })),
      putReasons(request("pause-reasons", "PUT", { pauseReasons: [], version: document.routingVersion })),
      putIvrMenus(request("ivr-menus", "PUT", { ivrMenus: [], version: document.routingVersion })),
      patchNumbers(request("numbers", "PATCH", { lineId: "line-1", patch: {} })),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403]);
    expect(replaceRingGroups).not.toHaveBeenCalled();
    expect(replaceIvrMenus).not.toHaveBeenCalled();
    expect(updateTelephonyLine).not.toHaveBeenCalled();
  });

  it("runs the same-origin check before the role gate", async () => {
    assertSameOriginRequest.mockImplementation(() => {
      throw new MutationError("Požiadavka neprešla bezpečnostnou kontrolou.", 403);
    });

    const response = await putPlans(request("ring-plans", "PUT", { plans: [], version: document.routingVersion }));
    expect(response.status).toBe(403);
    expect(replaceRingPlans).not.toHaveBeenCalled();
  });

  it("reports validation issues with 400 and the Slovak message", async () => {
    replaceRingPlans.mockRejectedValueOnce(
      new ConfigServiceError("Plán zvonenia potrebuje aspoň jeden krok.", 400, "config_invalid", [{ path: "plans[0]", code: "plan_empty", message: "Plán zvonenia potrebuje aspoň jeden krok." }]),
    );

    const response = await putPlans(request("ring-plans", "PUT", { plans: [], version: document.routingVersion }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "config_invalid", issues: [{ code: "plan_empty" }] });
  });

  it("maps an in-use conflict from the RPC onto 409", async () => {
    replaceRingGroups.mockRejectedValueOnce(new ConfigServiceError("Skupinu používa plán zvonenia, najprv ju odober z plánu.", 409, "ring_group_in_use"));

    const response = await putGroups(request("ring-groups", "PUT", { groups: VALID_GROUPS, version: document.routingVersion }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "ring_group_in_use" });
  });

  it("replaces the IVR menus for a manager and keeps the read member-level", async () => {
    state.role = "senior_dispatcher";
    expect((await getIvrMenus()).status).toBe(200);

    state.role = "manager";
    const menus = [
      {
        id: "00000000-0000-4000-8000-000000002401",
        name: "Hlavné menu",
        promptMediaUrl: "ivr-main.mp3",
        timeoutSecs: 5,
        maxTries: 2,
        options: [{ digit: "1", action: "ring_plan", targetRingPlanId: "00000000-0000-4000-8000-000000002301", label: "Dispečing" }],
      },
    ];
    const response = await putIvrMenus(request("ivr-menus", "PUT", { ivrMenus: menus, version: document.routingVersion }));

    expect(response.status).toBe(200);
    expect(assertSameOriginRequest).toHaveBeenCalledTimes(1);
    expect(replaceIvrMenus).toHaveBeenCalledWith(
      { admin: { marker: "admin" } },
      expect.objectContaining({
        organizationId: "org-1",
        expectedVersion: 7,
        ivrMenus: [expect.objectContaining({ name: "Hlavné menu", options: [expect.objectContaining({ digit: "1", action: "ring_plan" })] })],
      }),
    );
  });

  it("rejects a body that is not a list of IVR menus", async () => {
    const response = await putIvrMenus(request("ivr-menus", "PUT", { ivrMenus: { nope: true }, version: document.routingVersion }));
    expect(response.status).toBe(400);
    expect(replaceIvrMenus).not.toHaveBeenCalled();
  });

  it("refuses a whole-document save that carries no document version", async () => {
    const response = await putGroups(request("ring-groups", "PUT", { groups: VALID_GROUPS }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "version_required" });
    expect(replaceRingGroups).not.toHaveBeenCalled();
  });

  it("rejects a body that is not a list of groups", async () => {
    const response = await putGroups(request("ring-groups", "PUT", { groups: { nope: true }, version: document.routingVersion }));
    expect(response.status).toBe(400);
    expect(replaceRingGroups).not.toHaveBeenCalled();
  });

  it("patches one line and requires its identifier", async () => {
    const ok = await patchNumbers(request("numbers", "PATCH", { lineId: "line-1", patch: { label: "Hlavná linka", ringPlanId: null } }));
    expect(ok.status).toBe(200);
    expect(updateTelephonyLine).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lineId: "line-1", patch: { label: "Hlavná linka", ringPlanId: null } }));

    const missing = await patchNumbers(request("numbers", "PATCH", { patch: { label: "x" } }));
    expect(missing.status).toBe(400);
  });

  it("lets only an admin flip the kill switch", async () => {
    state.role = "manager";
    expect((await patchSettings(request("settings", "PATCH", { patch: { liveCallsEnabled: false } }))).status).toBe(403);
    expect(updateTelephonySettings).not.toHaveBeenCalled();

    state.role = "admin";
    const response = await patchSettings(request("settings", "PATCH", { patch: { liveCallsEnabled: false, destinationAllowlist: ["SK"] } }));
    expect(response.status).toBe(200);
    expect(updateTelephonySettings).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ patch: { liveCallsEnabled: false, destinationAllowlist: ["SK"] } }));
    await expect(response.json()).resolves.toMatchObject({ ok: true, settings: { liveCallsEnabled: true } });
  });
});
