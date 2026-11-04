import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordServerDiagnostic } from "@/server/diagnostics/record";
vi.mock("@/server/diagnostics/record", () => ({recordServerDiagnostic: vi.fn()}));
import { pendingCredentialEntries } from "@/lib/telephony/device-liveness";
import { clearRateLimits } from "@/server/rate-limit";

import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";

import { credentialName, decodeJwtExpiry, disconnectDevice, ensureOperatorCredential, getOperatorDevice, issueWebphoneToken, OperatorDeviceError, refuseIfAccessLost, touchDevice, type DeviceDeps } from "./operator-devices";
import { TelnyxCommandError } from "./telnyx/client";
import { deviceLastOnlineAt } from "./device-online";

function deps(h: ReturnType<typeof createTelephonyHarness>, overrides: Partial<DeviceDeps> = {}): DeviceDeps {
  return { admin: h.admin, telnyx: h.telnyx.client, environment: "development", now: () => h.now(), ...overrides };
}

describe("operator devices", () => {
  it("records a generic error heartbeat as device_error rather than inventing an authentication failure", async () => {
    const h = createTelephonyHarness();
    const issued = await issueWebphoneToken(deps(h), {organizationId: ORG, profileId: PROFILES.o1, takeover: true});
    await touchDevice(deps(h), {organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: issued.deviceSessionId, registrationState: "registered"});
    vi.mocked(recordServerDiagnostic).mockClear();
    const result = await touchDevice(deps(h), {organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: issued.deviceSessionId, registrationState: "error"});
    expect(result).toMatchObject({ok: true, device: {registration_state: "error"}});
    expect(recordServerDiagnostic).toHaveBeenCalledExactlyOnceWith({organizationId: ORG, profileId: PROFILES.o1}, {
      type: "phone_lifecycle", module: "telephony", outcome: "failed", reason: "device_error", deviceSessionId: issued.deviceSessionId,
    });
    await touchDevice(deps(h), {organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: issued.deviceSessionId, registrationState: "error"});
    expect(recordServerDiagnostic).toHaveBeenCalledOnce();
  });

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

  it("records the browser's own audio state on the device, keeping the rest of its metadata", async () => {
    const h = createTelephonyHarness();
    await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: "dev-1" });

    const reported = await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: "dev-1",
      registrationState: "registered", audio: { blocked: false, remoteMedia: false } });

    // "The colleague could not hear anything" is otherwise unanswerable from
    // the server: every leg is answered and bridged and the browser is the only
    // place left to look.
    expect(reported).toMatchObject({ ok: true });
    const metadataOfResult = (result: Awaited<ReturnType<typeof touchDevice>>) =>
      (result.ok ? result.device.metadata : null) as Record<string, unknown> | null;
    const metadata = metadataOfResult(reported)!;
    expect(metadata.audio).toMatchObject({ blocked: false, remoteMedia: false, at: expect.any(String) });
    // The merge keeps whatever the credential lifecycle already stored there.
    expect(Object.keys(metadata).length).toBeGreaterThan(1);

    const later = await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: "dev-1",
      registrationState: "registered", audio: { blocked: true, remoteMedia: true } });
    expect(metadataOfResult(later)?.audio).toMatchObject({ blocked: true, remoteMedia: true });
  });

  it("leaves the device metadata alone when the heartbeat carries no audio report", async () => {
    const h = createTelephonyHarness();
    await issueWebphoneToken(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: "dev-1" });
    await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: "dev-1", registrationState: "registered", audio: { blocked: true, remoteMedia: false } });

    const quiet = await touchDevice(deps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: "dev-1", registrationState: "registered" });

    // A tab with no call reports nothing; the last known state is not erased.
    expect((quiet.ok ? (quiet.device.metadata as Record<string, unknown>).audio : null))
      .toMatchObject({ blocked: true, remoteMedia: false });
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

describe("concurrent device enrollment", () => {
  it.each(["web", "mobile"] as const)("retains one %s credential and revokes a losing concurrent mint", async (deviceKind) => {
    const h = createTelephonyHarness();
    const table = deviceKind === "mobile" ? "motorist_operator_mobile_devices" : "motorist_operator_devices";
    const [first, second] = await Promise.all([0, 1].map(() => ensureOperatorCredential(deps(h, { deviceKind }), { organizationId: ORG, profileId: PROFILES.o3 })));
    expect(first.telnyx_credential_id).toBe(second.telnyx_credential_id);
    expect(h.rows(table).filter((row) => row.profile_id === PROFILES.o3)).toHaveLength(1);
    expect(h.telnyx.of("deleteTelephonyCredential")).toHaveLength(1);
    expect(h.telnyx.of("deleteTelephonyCredential")[0].params).not.toEqual({ credentialId: first.telnyx_credential_id });
  });

  it.each(["web", "mobile"] as const)("does not overwrite a concurrent %s credential renewal", async (deviceKind) => {
    const h = createTelephonyHarness();
    const deviceDeps = deps(h, { deviceKind });
    const input = { organizationId: ORG, profileId: PROFILES.o3 };
    const original = await ensureOperatorCredential(deviceDeps, input);
    const [first, second] = await Promise.all([0, 1].map(() => ensureOperatorCredential(deviceDeps, { ...input, force: true })));
    expect(first.telnyx_credential_id).toBe(second.telnyx_credential_id);
    expect(first.telnyx_credential_id).not.toBe(original.telnyx_credential_id);
    const deleted = h.telnyx.of("deleteTelephonyCredential").map((call) => call.params.credentialId);
    expect(deleted).toHaveLength(2);
    expect(deleted).toContain(original.telnyx_credential_id);
    expect(deleted).not.toContain(first.telnyx_credential_id);
  });

  it("revokes a new provider credential when the database rejects enrollment", async () => {
    const h = createTelephonyHarness();
    h.db.failNext("motorist_operator_mobile_devices", "insert", "db down");
    await expect(ensureOperatorCredential(deps(h, { deviceKind: "mobile" }), { organizationId: ORG, profileId: PROFILES.o3 })).rejects.toMatchObject({ status: 500 });
    expect(h.telnyx.of("deleteTelephonyCredential")[0].params).toEqual({ credentialId: "cred-1" });
    expect(h.rows("motorist_operator_mobile_devices")).toHaveLength(0);
  });
});

describe("retained last online contact", () => {
  it.each(["web", "mobile"] as const)("keeps the last verified %s contact across logout, token issue and forced disconnection", async (deviceKind) => {
    const h = createTelephonyHarness();
    const deviceDeps = deps(h, { deviceKind });
    const input = { organizationId: ORG, profileId: PROFILES.o3 };
    const issued = await issueWebphoneToken(deviceDeps, input);
    const read = async () => (await getOperatorDevice(deviceDeps,input))!;
    expect(deviceLastOnlineAt(await read(), h.now())).toBeNull();
    const registeredAt = h.now().toISOString();
    await touchDevice(deviceDeps, { ...input, deviceSessionId: issued.deviceSessionId, registrationState: "registered", audio: {blocked:true,remoteMedia:false} });
    h.advance(25_000);
    const left = await touchDevice(deviceDeps, { ...input, deviceSessionId: issued.deviceSessionId, registrationState: "unregistered" });
    expect(left).toMatchObject({ok:true,device:{device_seen_at:null,registration_state:"unregistered",metadata:{last_online_at:registeredAt,audio:{blocked:true}}}});
    h.advance(60_000);
    await touchDevice(deviceDeps, { ...input, deviceSessionId: issued.deviceSessionId, registrationState: "unregistered" });
    expect(deviceLastOnlineAt(await read(), h.now())).toBe(registeredAt);
    const replacement = await issueWebphoneToken(deviceDeps, {...input,takeover:true});
    expect(await read()).toMatchObject({device_seen_at:null,registration_state:"registering",metadata:{last_online_at:registeredAt,audio:{blocked:true},revoked_sessions:[{id:issued.deviceSessionId,revoked_at:h.now().toISOString()}]}});
    expect(await touchDevice(deviceDeps,{...input,deviceSessionId:issued.deviceSessionId,registrationState:"registered"})).toEqual({ok:false,reason:"stale_session"});
    expect(deviceLastOnlineAt(await read(), h.now())).toBe(registeredAt);
    await disconnectDevice(deviceDeps, input);
    expect(await read()).toMatchObject({device_seen_at:null,registration_state:"unregistered",metadata:{last_online_at:registeredAt,audio:{blocked:true}}});
    expect(await touchDevice(deviceDeps,{...input,deviceSessionId:replacement.deviceSessionId,registrationState:"registered"})).toEqual({ok:false,reason:"stale_session"});
  });

  it("retains a legacy registered heartbeat before takeover without using token time as online time", async () => {
    const h = createTelephonyHarness();
    const previous = h.rows("motorist_operator_devices").find(row=>row.profile_id===PROFILES.o1)!.device_seen_at;
    h.advance(600_000);
    await issueWebphoneToken(deps(h), {organizationId:ORG,profileId:PROFILES.o1,takeover:true});
    const row = (await getOperatorDevice(deps(h),{organizationId:ORG,profileId:PROFILES.o1}))!;
    expect(row).toMatchObject({device_seen_at:null,registration_state:"registering",metadata:{last_online_at:previous}});
    expect(row.last_token_issued_at).not.toBe(previous);
    expect(deviceLastOnlineAt(row,h.now())).toBe(previous);
  });

  it("does not count registering, error or unregistered reports as an online contact", async () => {
    const h = createTelephonyHarness();
    const input = {organizationId:ORG,profileId:PROFILES.o3};
    const issued = await issueWebphoneToken(deps(h),input);
    for (const registrationState of ["registering","error","unregistered"] as const) {
      h.advance(30_000);
      const result = await touchDevice(deps(h),{...input,deviceSessionId:issued.deviceSessionId,registrationState});
      expect(result.ok).toBe(true);
      if (result.ok) expect(deviceLastOnlineAt(result.device,h.now())).toBeNull();
    }
  });

  it("merges a heartbeat arriving during token renewal instead of losing contact/audio metadata", async () => {
    const h = createTelephonyHarness();
    const input = {organizationId:ORG,profileId:PROFILES.o1,deviceSessionId:"dev-1"};
    h.db.update("motorist_operator_devices",{metadata:{revoked_sessions:[{id:"old",revoked_at:"2026-09-01T00:00:00Z"}],unrelated:"keep"}},row=>row.profile_id===PROFILES.o1);
    const mint = h.telnyx.client.mintCredentialToken.bind(h.telnyx.client);
    let latestContact = "";
    h.telnyx.client.mintCredentialToken = async id => {
      const token = await mint(id);
      h.advance(20_000); latestContact = h.now().toISOString();
      await touchDevice(deps(h),{...input,registrationState:"registered",audio:{blocked:false,remoteMedia:true}});
      return token;
    };
    await issueWebphoneToken(deps(h),input);
    expect(h.rows("motorist_operator_devices").find(row=>row.profile_id===PROFILES.o1)).toMatchObject({
      device_seen_at:latestContact,registration_state:"registered",metadata:{last_online_at:latestContact,audio:{remoteMedia:true},unrelated:"keep",revoked_sessions:[{id:"old"}]},
    });
  });

  it("retains contact and audio updated while a replacement credential is being created", async () => {
    const h = createTelephonyHarness();
    const input = {organizationId:ORG,profileId:PROFILES.o1};
    const create = h.telnyx.client.createTelephonyCredential.bind(h.telnyx.client);
    let latestContact = "";
    h.telnyx.client.createTelephonyCredential = async params => {
      const credential = await create(params);
      h.advance(20_000); latestContact = h.now().toISOString();
      await touchDevice(deps(h),{...input,deviceSessionId:"dev-1",registrationState:"registered",audio:{blocked:true,remoteMedia:false}});
      return credential;
    };
    const rotated = await ensureOperatorCredential(deps(h),{...input,force:true});
    expect(rotated).toMatchObject({registration_state:"unregistered",device_seen_at:null,metadata:{last_online_at:latestContact,audio:{blocked:true}}});
    expect(await touchDevice(deps(h),{...input,deviceSessionId:"dev-1",registrationState:"registered"})).toEqual({ok:false,reason:"stale_session"});
    expect((await getOperatorDevice(deps(h),input))?.metadata).toMatchObject({last_online_at:latestContact});
  });

  it("does not clear a newer credential or roll back contact history after a slow provider disconnect", async () => {
    const h = createTelephonyHarness();
    const remove = h.telnyx.client.deleteTelephonyCredential.bind(h.telnyx.client);
    let winnerTime = "";
    h.telnyx.client.deleteTelephonyCredential = async id => {
      await remove(id);
      h.advance(25_000); winnerTime = h.now().toISOString();
      h.db.update("motorist_operator_devices",{
        device_session_id:"new-session",telnyx_credential_id:"new-credential",sip_username:"new-phone",registration_state:"registered",device_seen_at:winnerTime,
        metadata:{last_online_at:winnerTime,audio:{blocked:false,remoteMedia:true},revoked_sessions:[{id:"older-session"}]},
      },row=>row.profile_id===PROFILES.o1);
    };
    await expect(disconnectDevice(deps(h),{organizationId:ORG,profileId:PROFILES.o1})).rejects.toMatchObject({status:409});
    expect(await getOperatorDevice(deps(h),{organizationId:ORG,profileId:PROFILES.o1})).toMatchObject({
      device_session_id:"new-session",telnyx_credential_id:"new-credential",sip_username:"new-phone",registration_state:"registered",device_seen_at:winnerTime,
      metadata:{last_online_at:winnerTime,audio:{remoteMedia:true},revoked_sessions:[{id:"older-session"}]},
    });
  });

  it("rejects a heartbeat whose session is revoked after its initial read", async () => {
    const h = createTelephonyHarness();
    const update = h.db.update.bind(h.db);
    const retainedAt = h.now().toISOString();
    let switched = false;
    h.db.update = (table,patch,predicate) => {
      if (table === "motorist_operator_devices" && !switched && patch.device_seen_at) {
        switched = true;
        update(table,{device_session_id:"winner-session",registration_state:"unregistered",device_seen_at:null,metadata:{last_online_at:retainedAt,revoked_sessions:[{id:"dev-1"}]}},row=>row.profile_id===PROFILES.o1);
      }
      return update(table,patch,predicate);
    };
    h.advance(25_000);
    expect(await touchDevice(deps(h),{organizationId:ORG,profileId:PROFILES.o1,deviceSessionId:"dev-1",registrationState:"registered"})).toEqual({ok:false,reason:"stale_session"});
    expect(await getOperatorDevice(deps(h),{organizationId:ORG,profileId:PROFILES.o1})).toMatchObject({device_session_id:"winner-session",device_seen_at:null,metadata:{last_online_at:retainedAt,revoked_sessions:[{id:"dev-1"}]}});
  });
});

describe("mobile credential rotation on a replaced lease (call-speed S8.1)", () => {
  const OLD_LEASE = "00000000-0000-4000-8000-0000000000a1";
  const phone = (h: ReturnType<typeof createTelephonyHarness>) => deps(h, { deviceKind: "mobile" });
  const input = (change: Partial<Parameters<typeof issueWebphoneToken>[1]> = {}) => ({ organizationId: ORG, profileId: PROFILES.o1, rotateCredential: true, ...change });
  /** An iPhone that holds the lease, its credential and a live registration. */
  function seedPhone(h: ReturnType<typeof createTelephonyHarness>, change: Record<string, unknown> = {}) {
    h.db.seed("motorist_operator_mobile_devices", [{ organization_id: ORG, profile_id: PROFILES.o1, environment: "development", sip_username: "old-sip",
      telnyx_credential_id: "old-credential", device_session_id: OLD_LEASE, device_seen_at: h.now().toISOString(), registration_state: "registered", ...change }]);
  }
  const deleted = (h: ReturnType<typeof createTelephonyHarness>) => h.telnyx.of("deleteTelephonyCredential").map(call => (call.params as { credentialId: string }).credentialId);
  const row = async (h: ReturnType<typeof createTelephonyHarness>) => (await getOperatorDevice(phone(h), { organizationId: ORG, profileId: PROFILES.o1 }))!;
  const pendingOf = async (h: ReturnType<typeof createTelephonyHarness>) => pendingCredentialEntries((await row(h)).metadata);
  beforeEach(() => clearRateLimits());

  it("deletes the old phone's credential when another iPhone takes the lease over, and mints from the new one", async () => {
    const h = createTelephonyHarness(); seedPhone(h);
    const token = await issueWebphoneToken(phone(h), input({ takeover: true }));
    const row = await getOperatorDevice(phone(h), { organizationId: ORG, profileId: PROFILES.o1 });
    expect(deleted(h)).toEqual(["old-credential"]);
    expect(row).toMatchObject({ device_session_id: token.deviceSessionId, registration_state: "registering" });
    expect(row?.telnyx_credential_id).not.toBe("old-credential"); expect(row?.sip_username).not.toBe("old-sip");
    expect(h.telnyx.of("mintCredentialToken").at(-1)?.params).toEqual({ credentialId: row?.telnyx_credential_id });
    expect(token).toMatchObject({ credentialId: row?.telnyx_credential_id, sipUsername: row?.sip_username });
    // The old phone's lease is gone with its credential.
    expect(await touchDevice(phone(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: OLD_LEASE, registrationState: "registered" }))
      .toEqual({ ok: false, reason: "stale_session" });
  });
  it("rotates too when a new iPhone replaces an unreachable lease without an explicit takeover", async () => {
    const h = createTelephonyHarness(); seedPhone(h, { registration_state: "unregistered", device_seen_at: null });
    await issueWebphoneToken(phone(h), input());
    expect(deleted(h)).toEqual(["old-credential"]);
  });
  it("never rotates its own renewal, without the switch or for a browser", async () => {
    const h = createTelephonyHarness(); seedPhone(h);
    const renewed = await issueWebphoneToken(phone(h), input({ deviceSessionId: OLD_LEASE }));
    expect(renewed).toMatchObject({ deviceSessionId: OLD_LEASE, credentialId: "old-credential" });
    const off = createTelephonyHarness(); seedPhone(off);
    await issueWebphoneToken(phone(off), input({ takeover: true, rotateCredential: false }));
    const browser = createTelephonyHarness();
    await issueWebphoneToken(deps(browser), input({ takeover: true }));
    for (const harness of [h, off, browser]) {
      expect(deleted(harness)).toEqual([]); expect(harness.telnyx.of("createTelephonyCredential")).toEqual([]);
    }
  });
  it("rotates a revoked lease whose credential survived, and only enrolls one whose credential is gone", async () => {
    // A deactivation whose Telnyx deletion failed leaves exactly this row behind.
    const kept = createTelephonyHarness(); seedPhone(kept, { device_session_id: "revoked:00000000-0000-4000-8000-0000000000a2", registration_state: "unregistered" });
    await issueWebphoneToken(phone(kept), input());
    expect(deleted(kept)).toEqual(["old-credential"]);
    const gone = createTelephonyHarness();
    seedPhone(gone, { device_session_id: "revoked:00000000-0000-4000-8000-0000000000a2", registration_state: "unregistered", telnyx_credential_id: null, sip_username: null });
    await issueWebphoneToken(phone(gone), input());
    expect(deleted(gone)).toEqual([]); expect(gone.telnyx.of("createTelephonyCredential")).toHaveLength(1);
  });
  it("records how long a JWT issued for caching can log in, and rotates during that window even with the switch off", async () => {
    const h = createTelephonyHarness(); seedPhone(h);
    const token = await issueWebphoneToken(phone(h), input({ deviceSessionId: OLD_LEASE, rotateCredential: false, tokenCache: true }));
    const until = (await getOperatorDevice(phone(h), { organizationId: ORG, profileId: PROFILES.o1 }))?.metadata as Record<string, unknown>;
    // The JWT's own expiry plus an hour, never less.
    expect(Date.parse(String(until.token_cache_until)) - Date.parse(token.expiresAt)).toBe(3_600_000);
    // The switch was turned off since: a takeover still deletes the credential the old phone may have cached.
    await issueWebphoneToken(phone(h), input({ takeover: true, rotateCredential: false }));
    expect(deleted(h)).toEqual(["old-credential"]);
    // After the window the switch decides again.
    const later = createTelephonyHarness(); seedPhone(later, { metadata: { token_cache_until: new Date(later.now().getTime() - 1).toISOString() } });
    await issueWebphoneToken(phone(later), input({ takeover: true, rotateCredential: false }));
    expect(deleted(later)).toEqual([]);
  });
  it("keeps a credential Telnyx did not delete pending, mints nothing meanwhile and deletes it on the next request", async () => {
    const h = createTelephonyHarness(); seedPhone(h);
    const pending = async () => { const list = (await pendingOf(h)).map(entry => entry.id); return list.length ? list : undefined; };
    h.telnyx.failAlways("deleteTelephonyCredential", "provider down");
    await expect(issueWebphoneToken(phone(h), input({ takeover: true }))).rejects.toMatchObject({ status: 502 });
    expect(await pending()).toEqual(["old-credential"]); expect(h.telnyx.of("mintCredentialToken")).toEqual([]);
    // A second takeover while Telnyx keeps refusing neither mints nor loses the old ID.
    await expect(issueWebphoneToken(phone(h), input({ takeover: true }))).rejects.toMatchObject({ status: 502 });
    expect(await pending()).toEqual(["old-credential"]);
    expect(h.telnyx.of("createTelephonyCredential")).toHaveLength(1); expect(h.telnyx.of("mintCredentialToken")).toEqual([]);
    // Telnyx recovers: the old credential is deleted first, then a JWT is minted. The
    // credential of the failed switch was never handed out and is replaced as well.
    h.telnyx.clearFailures(); const attempts = deleted(h).length;
    const token = await issueWebphoneToken(phone(h), input({ takeover: true }));
    expect(deleted(h).slice(attempts)).toEqual(["old-credential", "cred-1"]); expect(await pending()).toBeUndefined();
    const order = h.telnyx.calls.map(call => call.method);
    expect(order.lastIndexOf("deleteTelephonyCredential")).toBeLessThan(order.indexOf("mintCredentialToken"));
    expect(token.credentialId).not.toBe("old-credential");
  });
  it("forgets a pending credential Telnyx no longer knows, and retries pending ones on every revocation", async () => {
    const h = createTelephonyHarness();
    seedPhone(h, { metadata: { pending_credential_deletions: ["gone-credential", "stale-credential"] } });
    h.telnyx.failNext("deleteTelephonyCredential", new TelnyxCommandError({ code: "not_found", status: 404, detail: "gone" }));
    const result = await disconnectDevice(phone(h), { organizationId: ORG, profileId: PROFILES.o1 });
    expect(deleted(h)).toEqual(["gone-credential", "stale-credential", "old-credential"]);
    expect(result?.device.metadata).not.toHaveProperty("pending_credential_deletions");
    expect(result).toMatchObject({ deletedCredentialId: "old-credential", device: { telnyx_credential_id: null } });
    const failing = createTelephonyHarness(); seedPhone(failing, { metadata: { pending_credential_deletions: ["stale-credential"] } });
    failing.telnyx.failNext("deleteTelephonyCredential", "provider down");
    await expect(disconnectDevice(phone(failing), { organizationId: ORG, profileId: PROFILES.o1 })).rejects.toMatchObject({ status: 502, code: "credential_cleanup_pending" });
    // The live credential still went; only the pending one is left for the retry.
    expect(deleted(failing)).toEqual(["stale-credential", "old-credential"]);
  });
  it("answers a replaced iPhone's renewal as stale and never lets it rotate the new phone's credential", async () => {
    const h = createTelephonyHarness(); seedPhone(h);
    const taken = await issueWebphoneToken(phone(h), input({ takeover: true }));
    const credential = (await getOperatorDevice(phone(h), { organizationId: ORG, profileId: PROFILES.o1 }))?.telnyx_credential_id;
    // The new phone is not yet registered, so the old one is not refused as "taken".
    await expect(issueWebphoneToken(phone(h), input({ deviceSessionId: OLD_LEASE }))).rejects.toMatchObject({ status: 409, code: "native_lease_stale" });
    expect(await getOperatorDevice(phone(h), { organizationId: ORG, profileId: PROFILES.o1 }))
      .toMatchObject({ device_session_id: taken.deviceSessionId, telnyx_credential_id: credential });
    expect(deleted(h)).toEqual(["old-credential"]);
    // Only a deliberate takeover moves it back.
    expect((await issueWebphoneToken(phone(h), input({ deviceSessionId: OLD_LEASE, takeover: true }))).deviceSessionId).not.toBe(taken.deviceSessionId);
  });
  it("names a lease held by a live phone and a lease that changed under the request apart", async () => {
    const h = createTelephonyHarness(); seedPhone(h);
    await expect(issueWebphoneToken(phone(h), input())).rejects.toMatchObject({ status: 409, code: "native_lease_taken" });
    const raced = createTelephonyHarness(); seedPhone(raced);
    const update = raced.db.update.bind(raced.db);
    let switched = false;
    raced.db.update = (table, patch, predicate) => {
      if (table === "motorist_operator_mobile_devices" && !switched && patch.last_token_issued_at) {
        switched = true; update(table, { device_session_id: "00000000-0000-4000-8000-0000000000a3" }, () => true);
      }
      return update(table, patch, predicate);
    };
    await expect(issueWebphoneToken(phone(raced), input({ deviceSessionId: OLD_LEASE }))).rejects.toMatchObject({ status: 409, code: "native_lease_contention" });
  });
  it("refuses a renewal whose lease another phone replaced while the request was under way", async () => {
    const h = createTelephonyHarness(); seedPhone(h);
    const B_LEASE = "00000000-0000-4000-8000-0000000000b1";
    const select = h.db.select.bind(h.db);
    let reads = 0;
    h.db.select = (table, filter) => {
      // B's takeover lands between the old phone's first read and its credential read.
      if (table === "motorist_operator_mobile_devices" && ++reads === 2) {
        h.db.update(table, { device_session_id: B_LEASE, telnyx_credential_id: "b-credential", sip_username: "b-sip", registration_state: "registering", device_seen_at: null,
          metadata: { revoked_sessions: [{ id: OLD_LEASE, revoked_at: h.now().toISOString() }] } }, () => true);
      }
      return select(table, filter);
    };
    await expect(issueWebphoneToken(phone(h), input({ deviceSessionId: OLD_LEASE }))).rejects.toMatchObject({ status: 409, code: "native_lease_stale" });
    expect(await row(h)).toMatchObject({ device_session_id: B_LEASE, telnyx_credential_id: "b-credential" });
    expect(h.telnyx.of("mintCredentialToken")).toEqual([]); expect(deleted(h)).toEqual([]);
  });
  it("remembers a replaced iPhone lease by age, not by count, and spends no slot on placeholders", async () => {
    const h = createTelephonyHarness(); seedPhone(h, { registration_state: "unregistered", device_seen_at: null });
    const old = new Date(h.now().getTime() - 8 * 24 * 3_600_000).toISOString();
    h.db.update("motorist_operator_mobile_devices", { metadata: { revoked_sessions: [{ id: "00000000-0000-4000-8000-0000000000c1", revoked_at: old }] } }, () => true);
    // Twelve phones take the lease over one after another (two slots each before this change).
    for (let index = 0; index < 12; index += 1) { clearRateLimits(); await issueWebphoneToken(phone(h), input({ takeover: true })); }
    const remembered = ((await row(h)).metadata as { revoked_sessions: Array<{ id: string }> }).revoked_sessions.map(entry => entry.id);
    expect(remembered).toContain(OLD_LEASE); expect(remembered).toHaveLength(12);
    expect(remembered.some(id => id.startsWith("revoked:") || id === "00000000-0000-4000-8000-0000000000c1")).toBe(false);
    clearRateLimits();
    await expect(issueWebphoneToken(phone(h), input({ deviceSessionId: OLD_LEASE }))).rejects.toMatchObject({ status: 409, code: "native_lease_stale" });
  });
  it("lets a replaced lease renew as before while rotation is off", async () => {
    const h = createTelephonyHarness(); seedPhone(h, { registration_state: "unregistered", device_seen_at: null,
      metadata: { revoked_sessions: [{ id: "00000000-0000-4000-8000-0000000000d1", revoked_at: new Date().toISOString() }] } });
    const token = await issueWebphoneToken(phone(h), input({ deviceSessionId: "00000000-0000-4000-8000-0000000000d1", rotateCredential: false }));
    expect(token.deviceSessionId).not.toBe(OLD_LEASE); expect(deleted(h)).toEqual([]);
  });
  it("never rotates under a call in progress, and bounds rotations per operator", async () => {
    const h = createTelephonyHarness(); seedPhone(h, { registration_state: "unregistered", device_seen_at: null });
    h.setPresence(PROFILES.o1, { status: "on_call", current_session_id: null });
    await expect(issueWebphoneToken(phone(h), input())).rejects.toMatchObject({ status: 409, code: "native_lease_on_call" });
    expect(deleted(h)).toEqual([]); expect(h.telnyx.of("createTelephonyCredential")).toEqual([]);
    const busy = createTelephonyHarness(); seedPhone(busy);
    for (let index = 0; index < 6; index += 1) await issueWebphoneToken(phone(busy), input({ takeover: true }));
    await expect(issueWebphoneToken(phone(busy), input({ takeover: true }))).rejects.toMatchObject({ status: 429 });
    expect(busy.telnyx.of("createTelephonyCredential")).toHaveLength(6);
  });
  it("blocks minting on a refused deletion until it failed five times AND for fifteen minutes, then keeps it pending and tells a manager once", async () => {
    const h = createTelephonyHarness(); seedPhone(h, { metadata: { pending_credential_deletions: ["stuck-credential"] } });
    h.telnyx.failAlways("deleteTelephonyCredential", "provider down");
    // Rapid retries (phone retries, push wakes) never unblock it on their own.
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await expect(issueWebphoneToken(phone(h), input({ deviceSessionId: OLD_LEASE }))).rejects.toMatchObject({ status: 502 });
    }
    expect(h.telnyx.of("mintCredentialToken")).toEqual([]);
    h.advance(14 * 60_000);
    await expect(issueWebphoneToken(phone(h), input({ deviceSessionId: OLD_LEASE }))).rejects.toMatchObject({ status: 502 });
    h.advance(60_000);
    const token = await issueWebphoneToken(phone(h), input({ deviceSessionId: OLD_LEASE }));
    expect(token.credentialId).toBe("old-credential");
    expect(await pendingOf(h)).toEqual([expect.objectContaining({ id: "stuck-credential", failures: 10, reported: true })]);
    await issueWebphoneToken(phone(h), input({ deviceSessionId: OLD_LEASE }));
    expect(await pendingOf(h)).toEqual([expect.objectContaining({ id: "stuck-credential", failures: 11 })]);
    expect(h.rows("motorist_audit_log").filter(entry => entry.action === "telephony.credential_deletion_stuck")).toEqual([
      expect.objectContaining({ entity_id: PROFILES.o1, after_payload: expect.objectContaining({ credentialId: "stuck-credential", deviceKind: "mobile", failures: 10, abandoned: false }) })]);
    // Age alone does not unblock it either.
    const aged = createTelephonyHarness();
    seedPhone(aged, { metadata: { pending_credential_deletions: [{ id: "stuck-credential", since: new Date(aged.now().getTime() - 16 * 60_000).toISOString(), failures: 1 }] } });
    aged.telnyx.failAlways("deleteTelephonyCredential", "provider down");
    await expect(issueWebphoneToken(phone(aged), input({ deviceSessionId: OLD_LEASE }))).rejects.toMatchObject({ status: 502 });
    // Telnyx recovers: the next pass deletes it.
    h.telnyx.clearFailures(); await issueWebphoneToken(phone(h), input({ deviceSessionId: OLD_LEASE }));
    expect(await pendingOf(h)).toEqual([]);
  });
  it("keeps every revocation fail-closed on a refused pending deletion, however old", async () => {
    const h = createTelephonyHarness();
    seedPhone(h, { metadata: { pending_credential_deletions: [{ id: "stuck-credential", since: new Date(h.now().getTime() - 24 * 3_600_000).toISOString(), failures: 50, reported: true }] } });
    h.telnyx.failNext("deleteTelephonyCredential", "provider down");
    await expect(disconnectDevice(phone(h), { organizationId: ORG, profileId: PROFILES.o1 })).rejects.toMatchObject({ status: 502, code: "credential_cleanup_pending" });
    // The revocation itself finished first: the lease and the live credential are gone.
    expect(deleted(h)).toEqual(["stuck-credential", "old-credential"]);
    expect(await row(h)).toMatchObject({ telnyx_credential_id: null }); expect((await row(h)).device_session_id).toMatch(/^revoked:/);
    expect((await pendingOf(h)).map(entry => entry.id)).toEqual(["stuck-credential"]);
    // Minting is relieved for the same entry; the revocation is not.
    h.telnyx.failNext("deleteTelephonyCredential", "provider down");
    expect((await issueWebphoneToken(phone(h), input({ rotateCredential: false }))).credentialId).not.toBe("old-credential");
  });
  it("reports a revocation as not done when the live credential itself survives", async () => {
    const h = createTelephonyHarness(); seedPhone(h);
    h.telnyx.failNext("deleteTelephonyCredential", "provider down");
    const refusal = await disconnectDevice(phone(h), { organizationId: ORG, profileId: PROFILES.o1 }).catch((error: { status: number; code?: string }) => error);
    expect(refusal).toMatchObject({ status: 502 }); expect((refusal as { code?: string }).code).toBeUndefined();
    expect(await row(h)).toMatchObject({ telnyx_credential_id: "old-credential" });
  });
  it("says nothing was revoked for a phone without a lease or credential", async () => {
    const h = createTelephonyHarness(); seedPhone(h, { device_session_id: null, telnyx_credential_id: null, sip_username: null, registration_state: "unregistered" });
    expect(await disconnectDevice(phone(h), { organizationId: ORG, profileId: PROFILES.o1 })).toMatchObject({ revoked: false });
    const live = createTelephonyHarness(); seedPhone(live);
    expect(await disconnectDevice(phone(live), { organizationId: ORG, profileId: PROFILES.o1 })).toMatchObject({ revoked: true });
  });
  it("drops an abandoned pending deletion only after its audit row is written", async () => {
    const h = createTelephonyHarness();
    seedPhone(h, { metadata: { pending_credential_deletions: [{ id: "ancient", since: new Date(h.now().getTime() - 8 * 24 * 3_600_000).toISOString(), failures: 300 }] } });
    h.db.failNext("motorist_audit_log", "insert", "audit unavailable");
    await issueWebphoneToken(phone(h), input({ deviceSessionId: OLD_LEASE, rotateCredential: false }));
    expect((await pendingOf(h)).map(entry => entry.id)).toEqual(["ancient"]); expect(deleted(h)).toEqual([]);
    await issueWebphoneToken(phone(h), input({ deviceSessionId: OLD_LEASE, rotateCredential: false }));
    expect(await pendingOf(h)).toEqual([]);
    expect(h.rows("motorist_audit_log").map(entry => (entry.after_payload as { credentialId: string }).credentialId)).toEqual(["ancient"]);
  });
  it("retries at most twenty pending deletions, none after a week, and audits the rest", async () => {
    const h = createTelephonyHarness();
    const week = new Date(h.now().getTime() - 8 * 24 * 3_600_000).toISOString();
    seedPhone(h, { metadata: { pending_credential_deletions: [{ id: "ancient", since: week, failures: 300, reported: true },
      ...Array.from({ length: 22 }, (_, index) => `pending-${index}`)] } });
    h.telnyx.failAlways("deleteTelephonyCredential", "provider down");
    await expect(disconnectDevice(phone(h), { organizationId: ORG, profileId: PROFILES.o1 })).rejects.toMatchObject({ status: 502 });
    // Twenty retried, then the live credential (refused too).
    expect(deleted(h)).toEqual([...Array.from({ length: 20 }, (_, index) => `pending-${index + 2}`), "old-credential"]);
    expect((await pendingOf(h)).map(entry => entry.id)).toEqual(Array.from({ length: 20 }, (_, index) => `pending-${index + 2}`));
    expect(h.rows("motorist_audit_log").filter(entry => (entry.after_payload as { abandoned?: boolean }).abandoned).map(entry => (entry.after_payload as { credentialId: string }).credentialId))
      .toEqual(["ancient", "pending-0", "pending-1"]);
  });
  it("keeps the phone of a signed-in user who is active but still invited", async () => {
    const h = createTelephonyHarness(); seedPhone(h);
    h.db.update("motorist_profiles", { access_status: "invited" }, row => row.id === PROFILES.o1);
    await refuseIfAccessLost(phone(h), { organizationId: ORG, profileId: PROFILES.o1 }, { credentialId: "old-credential" });
    expect(deleted(h)).toEqual([]); expect(await row(h)).toMatchObject({ telnyx_credential_id: "old-credential", device_session_id: OLD_LEASE });
  });
  it("withholds a token minted for an operator deactivated or removed meanwhile, revoking what it enrolled", async () => {
    const h = createTelephonyHarness(); seedPhone(h);
    await refuseIfAccessLost(phone(h), { organizationId: ORG, profileId: PROFILES.o1 }, { credentialId: "old-credential" });
    expect(deleted(h)).toEqual([]);
    h.db.update("motorist_profiles", { active: false, access_status: "disabled" }, row => row.id === PROFILES.o1);
    await expect(refuseIfAccessLost(phone(h), { organizationId: ORG, profileId: PROFILES.o1 }, { credentialId: "old-credential" }))
      .rejects.toMatchObject({ status: 403, code: "native_access_revoked" });
    expect(deleted(h)).toEqual(["old-credential"]); expect(await row(h)).toMatchObject({ telnyx_credential_id: null });
    // Removed: the row went with the profile, so the issued credential is deleted directly.
    const removed = createTelephonyHarness();
    removed.db.delete("motorist_profiles", entry => entry.id === PROFILES.o1);
    await expect(refuseIfAccessLost(phone(removed), { organizationId: ORG, profileId: PROFILES.o1 }, { credentialId: "issued-credential" }))
      .rejects.toMatchObject({ status: 403 });
    expect(deleted(removed)).toEqual(["issued-credential"]);
  });
});
