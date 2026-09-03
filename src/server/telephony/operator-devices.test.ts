import { describe, expect, it } from "vitest";

import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";

import { credentialName, decodeJwtExpiry, disconnectDevice, ensureOperatorCredential, issueWebphoneToken, OperatorDeviceError, touchDevice, type DeviceDeps } from "./operator-devices";

function deps(h: ReturnType<typeof createTelephonyHarness>, overrides: Partial<DeviceDeps> = {}): DeviceDeps {
  return { admin: h.admin, telnyx: h.telnyx.client, environment: "development", now: () => h.now(), ...overrides };
}

describe("operator devices", () => {
  it("creates a Telnyx credential lazily, once, on the environment's credential connection", async () => {
    const h = createTelephonyHarness();
    const device = await ensureOperatorCredential(deps(h), { organizationId: ORG, profileId: PROFILES.o3 });
    expect(device).toMatchObject({ profile_id: PROFILES.o3, environment: "development", telnyx_credential_id: "cred-1", sip_username: "gencred1", registration_state: "unregistered" });
    expect(h.telnyx.of("createTelephonyCredential")[0].params).toMatchObject({ name: credentialName("development", PROFILES.o3), tag: "pomoc-motoristom" });

    const again = await ensureOperatorCredential(deps(h), { organizationId: ORG, profileId: PROFILES.o3 });
    expect(again.id).toBe(device.id);
    expect(h.telnyx.of("createTelephonyCredential")).toHaveLength(1);
    // Existing seeded devices are reused as well.
    await ensureOperatorCredential(deps(h), { organizationId: ORG, profileId: PROFILES.o1 });
    expect(h.telnyx.of("createTelephonyCredential")).toHaveLength(1);
  });

  it("renews a credential that is about to expire and fails with 503 when not configured", async () => {
    const h = createTelephonyHarness();
    h.db.update("motorist_operator_devices", { credential_expires_at: new Date(h.now().getTime() + 60_000).toISOString() }, (row) => row.profile_id === PROFILES.o1);
    const renewed = await ensureOperatorCredential(deps(h), { organizationId: ORG, profileId: PROFILES.o1 });
    // The fake Telnyx numbers credentials from 1; the seeded row also carried "cred-1", which is kept as history.
    expect(renewed.telnyx_credential_id).toBe("cred-1");
    expect(h.telnyx.of("createTelephonyCredential")).toHaveLength(1);
    expect((renewed.metadata as { previous_credential_id: string }).previous_credential_id).toBe("cred-1");
    await expect(ensureOperatorCredential(deps(h, { telnyx: null }), { organizationId: ORG, profileId: PROFILES.o4 })).rejects.toMatchObject({ status: 503 });
  });

  it("issues a webphone token, decodes its expiry and rotates the device session", async () => {
    const h = createTelephonyHarness();
    const first = await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1, userAgent: "tab-1" });
    expect(first.sipUsername).toBe("gencred001");
    expect(first.token.split(".")).toHaveLength(3);
    expect(decodeJwtExpiry(first.token)?.toISOString()).toBe(first.expiresAt);
    const row1 = h.db.find("motorist_operator_devices", (row) => row.profile_id === PROFILES.o1)!;
    // The seeded device is registered and still sending heartbeats, so a token
    // refresh keeps it registered — downgrading it would hide the operator from
    // the ring engine until the next heartbeat.
    expect(row1).toMatchObject({ device_session_id: first.deviceSessionId, registration_state: "registered", user_agent: "tab-1", last_token_issued_at: h.now().toISOString(), token_expires_at: first.expiresAt });

    const second = await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1, userAgent: "tab-2" });
    expect(second.deviceSessionId).not.toBe(first.deviceSessionId);
    const row2 = h.db.find("motorist_operator_devices", (row) => row.profile_id === PROFILES.o1)!;
    expect((row2.metadata as { revoked_sessions: Array<{ id: string }> }).revoked_sessions.map((entry) => entry.id)).toEqual(["dev-1", first.deviceSessionId]);
    expect(decodeJwtExpiry("not-a-jwt")).toBeNull();
  });

  it("starts a token as registering when the phone is not live, and keeps it registered when it is", async () => {
    const h = createTelephonyHarness();
    // A device whose heartbeat has gone stale must re-register before it can be
    // offered a call again.
    h.db.update(
      "motorist_operator_devices",
      { registration_state: "registered", device_seen_at: new Date(h.now().getTime() - 10 * 60_000).toISOString() },
      (row) => row.profile_id === PROFILES.o1,
    );
    await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1 });
    expect(h.db.find("motorist_operator_devices", (row) => row.profile_id === PROFILES.o1)?.registration_state).toBe("registering");

    const live = await touchDevice(deps(h), {
      organizationId: ORG,
      profileId: PROFILES.o1,
      deviceSessionId: String(h.db.find("motorist_operator_devices", (row) => row.profile_id === PROFILES.o1)!.device_session_id),
      registrationState: "registered",
    });
    expect(live.ok).toBe(true);
    await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1 });
    expect(h.db.find("motorist_operator_devices", (row) => row.profile_id === PROFILES.o1)?.registration_state).toBe("registered");
  });

  it("refuses to revoke a live device that is on a call unless the takeover is explicit", async () => {
    const h = createTelephonyHarness();
    const first = await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1 });
    await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: first.deviceSessionId, registrationState: "registered" });
    h.setPresence(PROFILES.o1, { status: "on_call", current_session_id: null });

    await expect(issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1 })).rejects.toMatchObject({ status: 409 });
    expect(h.db.find("motorist_operator_devices", (row) => row.profile_id === PROFILES.o1)?.device_session_id).toBe(first.deviceSessionId);

    const takeover = await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1, takeover: true });
    expect(takeover.deviceSessionId).not.toBe(first.deviceSessionId);
  });

  it("lets the tab that owns the credential renew it while on a call", async () => {
    const h = createTelephonyHarness();
    const first = await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1 });
    await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: first.deviceSessionId, registrationState: "registered" });
    h.setPresence(PROFILES.o1, { status: "on_call", current_session_id: null });

    // Same tab (its own `device_session_id`): a scheduled refresh, not a takeover.
    const refreshed = await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: first.deviceSessionId });
    expect(refreshed.deviceSessionId).not.toBe(first.deviceSessionId);
    expect(h.db.find("motorist_operator_devices", (row) => row.profile_id === PROFILES.o1)?.device_session_id).toBe(refreshed.deviceSessionId);

    // A different tab (a stale session id, or none at all) is still refused
    // once the renewed tab has registered again.
    await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: refreshed.deviceSessionId, registrationState: "registered" });
    await expect(issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: first.deviceSessionId })).rejects.toMatchObject({ status: 409 });
    await expect(issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1 })).rejects.toMatchObject({ status: 409 });
  });

  it("clears the liveness stamp when a leaving tab reports itself unregistered", async () => {
    const h = createTelephonyHarness();
    const issued = await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1 });
    await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: issued.deviceSessionId, registrationState: "registered" });

    const left = await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: issued.deviceSessionId, registrationState: "unregistered" });

    expect(left).toMatchObject({ ok: true, device: { device_seen_at: null, registration_state: "unregistered" } });
  });

  it("accepts heartbeats only from the current device session", async () => {
    const h = createTelephonyHarness();
    const issued = await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1 });
    h.advance(10_000);
    const ok = await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: issued.deviceSessionId, registrationState: "registered" });
    expect(ok).toMatchObject({ ok: true, device: { device_seen_at: h.now().toISOString(), registration_state: "registered" } });
    expect(await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: "dev-1" })).toEqual({ ok: false, reason: "stale_session" });
    expect(await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o4, deviceSessionId: "x" })).toEqual({ ok: false, reason: "unknown_device" });

    const disconnected = await disconnectDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1 });
    expect(disconnected).toMatchObject({ registration_state: "unregistered", device_seen_at: null });
    expect(await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: issued.deviceSessionId })).toEqual({ ok: false, reason: "stale_session" });
  });

  it("wraps database failures in OperatorDeviceError", async () => {
    const h = createTelephonyHarness();
    h.db.failNext("motorist_operator_devices", "select", "db down");
    await expect(ensureOperatorCredential(deps(h), { organizationId: ORG, profileId: PROFILES.o1 })).rejects.toBeInstanceOf(OperatorDeviceError);
  });
});
