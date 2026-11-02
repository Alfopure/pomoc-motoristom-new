import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultLatencyFlags, type LatencyFlags } from "@/server/telephony/latency-flags";
import { OperatorDeviceError } from "@/server/telephony/operator-devices";

const issueWebphoneToken = vi.fn();
/** Deps without flags stand for those built outside `createTelephonyDeps`: env alone. */
let latencyFlags: LatencyFlags | undefined;
const refuseIfAccessLost = vi.fn();

vi.mock("@/server/api-auth", () => ({
  requireDefaultMotoristActor: async () => ({ userId: "user-1", profileId: "profile-1", organizationId: "org-1", displayName: "Jana", role: "dispatcher" as const }),
  assertSameOriginRequest: () => {},
}));

vi.mock("@/server/telephony/operator-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/operator-devices")>();
  return { ...actual, issueWebphoneToken: (...args: unknown[]) => issueWebphoneToken(...args), refuseIfAccessLost: (...args: unknown[]) => refuseIfAccessLost(...args) };
});

vi.mock("@/server/telephony/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/runtime")>();
  return { ...actual, createTelephonyDeps: async () => ({ admin: { marker: "admin" }, telnyx: { marker: "telnyx" }, environment: "development", organizationId: "org-1", config: { configured: true },
    ...(latencyFlags ? { latencyFlags } : {}) }) };
});

import { POST } from "./route";

const request = () => new Request("https://app.test/api/telephony/webphone/token", { method: "POST", headers: { "user-agent": "vitest" } });

describe("POST /api/telephony/webphone/token", () => {
  beforeEach(() => {
    process.env.TELNYX_API_KEY = "KEYtest";
    issueWebphoneToken.mockReset();
    refuseIfAccessLost.mockReset(); refuseIfAccessLost.mockResolvedValue(undefined);
  });

  it("withholds a token minted while the operator lost access, after revoking it", async () => {
    issueWebphoneToken.mockResolvedValue({ token: "jwt", expiresAt: "2026-09-04T08:00:00.000Z", deviceSessionId: "dev-2", sipUsername: "gencred001", credentialId: "cred-1" });
    refuseIfAccessLost.mockRejectedValue(new OperatorDeviceError("Prístup k telefónu bol zrušený.", 403, { code: "native_access_revoked" }));
    const response = await POST(request());
    expect(response.status).toBe(403); expect(JSON.stringify(await response.json())).not.toContain("jwt");
    expect(refuseIfAccessLost).toHaveBeenCalledWith(expect.objectContaining({ deviceKind: "web" }), { organizationId: "org-1", profileId: "profile-1" },
      expect.objectContaining({ credentialId: "cred-1" }));
  });

  afterEach(() => {
    delete process.env.TELNYX_API_KEY;
    latencyFlags = undefined;
    vi.unstubAllEnvs();
  });

  it("hands the browser its connect-time switches, off unless the flags turn them on (call-speed S5)", async () => {
    issueWebphoneToken.mockResolvedValue({ token: "jwt", expiresAt: "2026-09-04T08:00:00.000Z", deviceSessionId: "dev-2", sipUsername: "gencred001", credentialId: "cred-1" });
    const switches = async () => {
      const { webRtcRegion, webPrefetchIce } = await (await POST(request())).json();
      return { webRtcRegion, webPrefetchIce };
    };

    vi.stubEnv("TELEPHONY_LATENCY_FLAGS", "");
    await expect(switches()).resolves.toEqual({ webRtcRegion: "auto", webPrefetchIce: false });
    // Values the flags reject never reach the browser.
    vi.stubEnv("TELEPHONY_LATENCY_FLAGS", JSON.stringify({ client: { webRtcRegion: "us-central", webPrefetchIce: "yes" } }));
    await expect(switches()).resolves.toEqual({ webRtcRegion: "auto", webPrefetchIce: false });

    const flags = defaultLatencyFlags();
    latencyFlags = { ...flags, client: { ...flags.client, webRtcRegion: "eu", webPrefetchIce: true } };
    await expect(switches()).resolves.toEqual({ webRtcRegion: "eu", webPrefetchIce: true });
  });

  it("mints a token and never caches it", async () => {
    issueWebphoneToken.mockResolvedValue({ token: "jwt", expiresAt: "2026-09-04T08:00:00.000Z", deviceSessionId: "dev-2", sipUsername: "gencred001", credentialId: "cred-1" });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({ token: "jwt", deviceSessionId: "dev-2", sipUsername: "gencred001" });
    expect(issueWebphoneToken).toHaveBeenCalledWith(
      { admin: { marker: "admin" }, telnyx: { marker: "telnyx" }, environment: "development", deviceKind: "web" },
      { organizationId: "org-1", profileId: "profile-1", userAgent: "vitest", takeover: false, handoff: false, deviceSessionId: null },
    );
  });

  it("passes an explicit takeover through to the device layer", async () => {
    issueWebphoneToken.mockResolvedValue({ token: "jwt", expiresAt: "2026-09-04T08:00:00.000Z", deviceSessionId: "dev-3", sipUsername: "gencred001", credentialId: "cred-1" });

    const response = await POST(
      new Request("https://app.test/api/telephony/webphone/token", {
        method: "POST",
        headers: { "user-agent": "vitest", "content-type": "application/json" },
        body: JSON.stringify({ takeover: true }),
      }),
    );

    expect(response.status).toBe(200);
    expect(issueWebphoneToken).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ takeover: true }));
  });

  it("maps a provisioning failure onto its own status", async () => {
    issueWebphoneToken.mockRejectedValue(new OperatorDeviceError("Telnyx nevrátil SIP používateľa pre nové prihlasovacie údaje.", 502));

    const response = await POST(request());

    expect(response.status).toBe(502);
  });

  it("returns 503 while telephony is not configured", async () => {
    delete process.env.TELNYX_API_KEY;

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(issueWebphoneToken).not.toHaveBeenCalled();
  });
});
