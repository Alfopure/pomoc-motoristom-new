import { describe, expect, it } from "vitest";

import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";

import { credentialName, decodeJwtExpiry, disconnectDevice, ensureOperatorCredential, issueWebphoneToken, OperatorDeviceError, touchDevice, type DeviceDeps } from "./operator-devices";
import { TelnyxCommandError } from "./telnyx/client";

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
    const first = await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1, takeover: true, userAgent: "tab-1" });
    expect(first.sipUsername).toBe("gencred001");
    expect(first.token.split(".")).toHaveLength(3);
    expect(decodeJwtExpiry(first.token)?.toISOString()).toBe(first.expiresAt);
    const row1 = h.db.find("motorist_operator_devices", (row) => row.profile_id === PROFILES.o1)!;
    // A new window must confirm its own registration before receiving calls.
    expect(row1).toMatchObject({ device_session_id: first.deviceSessionId, registration_state: "registering", device_seen_at: null, user_agent: "tab-1", last_token_issued_at: h.now().toISOString(), token_expires_at: first.expiresAt });

    const second = await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1, userAgent: "tab-2", takeover: true });
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
    await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: live.ok ? live.device.device_session_id : undefined });
    expect(h.db.find("motorist_operator_devices", (row) => row.profile_id === PROFILES.o1)?.registration_state).toBe("registered");
  });

  it("refuses to revoke a device during a live call even with explicit takeover", async () => {
    const h = createTelephonyHarness();
    const first = await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1, takeover: true });
    await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: first.deviceSessionId, registrationState: "registered" });
    h.setPresence(PROFILES.o1, { status: "on_call", current_session_id: null });

    await expect(issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1 })).rejects.toMatchObject({ status: 409 });
    expect(h.db.find("motorist_operator_devices", (row) => row.profile_id === PROFILES.o1)?.device_session_id).toBe(first.deviceSessionId);

    await expect(issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1, takeover: true })).rejects.toMatchObject({ status: 409 });
  });

  it("lets the tab that owns the credential renew it while on a call", async () => {
    const h = createTelephonyHarness();
    const first = await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1, takeover: true });
    await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: first.deviceSessionId, registrationState: "registered" });
    h.setPresence(PROFILES.o1, { status: "on_call", current_session_id: null });

    // Same tab (its own `device_session_id`): a scheduled refresh, not a takeover.
    const refreshed = await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: first.deviceSessionId });
    expect(refreshed.deviceSessionId).toBe(first.deviceSessionId);
    expect(h.db.find("motorist_operator_devices", (row) => row.profile_id === PROFILES.o1)?.device_session_id).toBe(refreshed.deviceSessionId);

    // A different tab (a stale session id, or none at all) is still refused
    // once the renewed tab has registered again.
    await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: refreshed.deviceSessionId, registrationState: "registered" });
    await expect(issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: "old-window" })).rejects.toMatchObject({ status: 409 });
    await expect(issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1 })).rejects.toMatchObject({ status: 409 });
  });

  it.each(["available", "ringing", "on_call"] as const)("does not let a second window silently steal a %s phone", async (status) => {
    const h = createTelephonyHarness();
    h.setPresence(PROFILES.o1, { status });
    await expect(issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1 })).rejects.toMatchObject({ status: 409 });
    expect(h.telnyx.of("mintCredentialToken")).toHaveLength(0);
    expect(await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: "dev-1", registrationState: "registered" })).toMatchObject({ ok: true });
  });

  it("keeps in-flight heartbeats valid when the same window refreshes its token", async () => {
    const h = createTelephonyHarness();
    const token = await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: "dev-1" });
    expect(token.deviceSessionId).toBe("dev-1");
    expect(await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: "dev-1", registrationState: "registered" })).toMatchObject({ ok: true });
    expect(h.db.find("motorist_operator_devices", (row) => row.profile_id === PROFILES.o1)?.registration_state).toBe("registered");
  });

  it("does not let a slow token renewal overwrite a newer device session", async () => {
    const h = createTelephonyHarness();
    const mint = h.telnyx.client.mintCredentialToken.bind(h.telnyx.client);
    h.telnyx.client.mintCredentialToken = async (id) => {
      const token = await mint(id);
      h.db.update("motorist_operator_devices", { device_session_id: "new-window", registration_state: "registering" }, (row) => row.profile_id === PROFILES.o1);
      return token;
    };
    await expect(issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: "dev-1" })).rejects.toMatchObject({ status: 409 });
    expect(h.db.find("motorist_operator_devices", (row) => row.profile_id === PROFILES.o1)?.device_session_id).toBe("new-window");
  });

  it("clears the liveness stamp when a leaving tab reports itself unregistered", async () => {
    const h = createTelephonyHarness();
    const issued = await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1, takeover: true });
    await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: issued.deviceSessionId, registrationState: "registered" });

    const left = await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: issued.deviceSessionId, registrationState: "unregistered" });

    expect(left).toMatchObject({ ok: true, device: { device_seen_at: null, registration_state: "unregistered" } });
  });

  it("accepts heartbeats only from the current device session", async () => {
    const h = createTelephonyHarness();
    const issued = await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1, takeover: true });
    h.advance(10_000);
    const ok = await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: issued.deviceSessionId, registrationState: "registered" });
    expect(ok).toMatchObject({ ok: true, device: { device_seen_at: h.now().toISOString(), registration_state: "registered" } });
    expect(await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: "dev-1" })).toEqual({ ok: false, reason: "stale_session" });
    expect(await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o4, deviceSessionId: "x" })).toEqual({ ok: false, reason: "unknown_device" });

    const disconnected = await disconnectDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1 });
    expect(disconnected?.device).toMatchObject({ registration_state: "unregistered", device_seen_at: null });
    expect(await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: issued.deviceSessionId })).toEqual({ ok: false, reason: "stale_session" });
  });

  it("deletes the credential at Telnyx when the phone is disconnected, so a stale token cannot re-register", async () => {
    const h = createTelephonyHarness();
    const before = h.db.find("motorist_operator_devices", (row) => row.profile_id === PROFILES.o1)!;
    expect(before.telnyx_credential_id).toBeTruthy();

    const result = await disconnectDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1 });

    expect(result?.deletedCredentialId).toBe(before.telnyx_credential_id);
    expect(h.telnyx.of("deleteTelephonyCredential")[0].params).toEqual({ credentialId: before.telnyx_credential_id });
    // The SIP identity is gone from the row as well: the next login provisions a new one.
    expect(result?.device).toMatchObject({ telnyx_credential_id: null, sip_username: null });
  });

  it("keeps the credential on the rotate path and reports a failed Telnyx delete as 502", async () => {
    const h = createTelephonyHarness();
    const kept = await disconnectDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, keepCredential: true });
    expect(kept?.deletedCredentialId).toBeNull();
    expect(h.telnyx.of("deleteTelephonyCredential")).toHaveLength(0);

    const other = createTelephonyHarness();
    other.telnyx.failNext("deleteTelephonyCredential", "credential delete refused");
    await expect(disconnectDevice(deps(other), { organizationId: ORG, profileId: PROFILES.o1 })).rejects.toMatchObject({ status: 502 });
    // The browser session is revoked either way; only the provider side failed.
    expect(other.db.find("motorist_operator_devices", (row) => row.profile_id === PROFILES.o1)?.device_session_id).toMatch(/^revoked:/);
  });

  it("treats an already-deleted credential as revoked instead of bricking the phone", async () => {
    const h = createTelephonyHarness();
    // The ordinary renewal path deletes the superseded credential too. If
    // Telnyx already expired it (or somebody removed it in the portal), a 404
    // means access is revoked — failing here would leave the operator unable to
    // get a token at all.
    h.telnyx.failNext("deleteTelephonyCredential", new TelnyxCommandError({ code: "resource_not_found", status: 404, detail: "not found" }));
    const result = await disconnectDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1 });
    expect(result?.device).toMatchObject({ telnyx_credential_id: null, sip_username: null });
  });

  it("deletes the superseded credential when a manager regenerates one", async () => {
    const h = createTelephonyHarness();
    const first = await ensureOperatorCredential(deps(h), { organizationId: ORG, profileId: PROFILES.o3 });
    const rotated = await ensureOperatorCredential(deps(h), { organizationId: ORG, profileId: PROFILES.o3, force: true });

    expect(rotated.telnyx_credential_id).not.toBe(first.telnyx_credential_id);
    // Without the delete, "new credentials" would only rename the identity: the
    // old one keeps registering and its 24 h JWT keeps working.
    expect(h.telnyx.of("deleteTelephonyCredential")[0].params).toEqual({ credentialId: first.telnyx_credential_id });
  });

  it("wraps database failures in OperatorDeviceError", async () => {
    const h = createTelephonyHarness();
    h.db.failNext("motorist_operator_devices", "select", "db down");
    await expect(ensureOperatorCredential(deps(h), { organizationId: ORG, profileId: PROFILES.o1 })).rejects.toBeInstanceOf(OperatorDeviceError);
  });
});
