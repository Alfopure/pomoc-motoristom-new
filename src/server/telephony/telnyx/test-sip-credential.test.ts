import { describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { hasTestCallProvenance, resolveTestSipCredential, type ProviderBoundary } from "./test-safety";

vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));

describe("TEST SIP enrollment boundary", () => {
  it("resolves only the enrolled development web/mobile credential, never production or arbitrary SIP", async () => {
    const fake = createFakeSupabase();
    vi.mocked(createSupabaseAdminClient).mockReturnValue(fake.admin);
    fake.db.seed("motorist_organizations", [{ id: "org", slug: "pomoc-motoristom", active: true }]);
    fake.db.seed("motorist_profiles", [{ id: "profile", organization_id: "org", active: true, access_status: "active", kind: "human" }]);
    fake.db.seed("motorist_operator_devices", [
      { organization_id: "org", profile_id: "profile", environment: "production", sip_username: "prod_user", telnyx_credential_id: "prod" },
      { organization_id: "org", profile_id: "profile", environment: "development", sip_username: "test_web", telnyx_credential_id: "web" },
    ]);
    fake.db.seed("motorist_operator_mobile_devices", [{ organization_id: "org", profile_id: "profile", environment: "development", sip_username: "test_mobile", telnyx_credential_id: "mobile" }]);
    await expect(resolveTestSipCredential("test_web")).resolves.toBe("web");
    await expect(resolveTestSipCredential("test_mobile")).resolves.toBe("mobile");
    await expect(resolveTestSipCredential("prod_user")).rejects.toMatchObject({ code: "test_provider_boundary" });
    await expect(resolveTestSipCredential("unknown")).rejects.toMatchObject({ code: "test_provider_boundary" });
  });
  it("fails closed on ambiguous copied identities", async () => {
    const fake = createFakeSupabase();
    vi.mocked(createSupabaseAdminClient).mockReturnValue(fake.admin);
    fake.db.seed("motorist_organizations", [{ id: "org", slug: "pomoc-motoristom", active: true }]);
    fake.db.seed("motorist_profiles", [{ id: "profile", organization_id: "org", active: true, access_status: "active", kind: "human" }]);
    fake.db.seed("motorist_operator_devices", [{ organization_id: "org", profile_id: "profile", environment: "development", sip_username: "same", telnyx_credential_id: "web" }]);
    fake.db.seed("motorist_operator_mobile_devices", [{ organization_id: "org", profile_id: "profile", environment: "development", sip_username: "same", telnyx_credential_id: "mobile" }]);
    await expect(resolveTestSipCredential("same")).rejects.toMatchObject({ code: "test_provider_boundary" });
  });
  it("rejects another organization's devices and disabled profiles", async () => {
    const fake = createFakeSupabase(); vi.mocked(createSupabaseAdminClient).mockReturnValue(fake.admin);
    fake.db.seed("motorist_organizations", [{ id: "org", slug: "pomoc-motoristom", active: true }]);
    fake.db.seed("motorist_profiles", [{ id: "profile", organization_id: "org", active: false, access_status: "disabled", kind: "human" }]);
    fake.db.seed("motorist_operator_devices", [
      { organization_id: "foreign", profile_id: "foreign", environment: "development", sip_username: "foreign", telnyx_credential_id: "other" },
      { organization_id: "org", profile_id: "profile", environment: "development", sip_username: "disabled", telnyx_credential_id: "own" },
    ]);
    await expect(resolveTestSipCredential("foreign")).rejects.toMatchObject({ code: "test_provider_boundary" });
    await expect(resolveTestSipCredential("disabled")).rejects.toMatchObject({ code: "test_provider_boundary" });
  });
});

describe("TEST call provenance", () => {
  const boundary: ProviderBoundary = { callControlAppId: "test-app", credentialConnectionId: "test-sip", messagingProfileId: null,
    safety: { restricted: true, deploymentAllowed: true, enabled: false, allowedNumbers: [], fromNumbers: [] } };
  it("does not trust copied session/leg rows; requires a signed TEST initiation or accepted TEST dial ACK", async () => {
    const fake = createFakeSupabase(); vi.mocked(createSupabaseAdminClient).mockReturnValue(fake.admin);
    fake.db.seed("motorist_organizations", [{ id: "org", slug: "pomoc-motoristom", active: true }]);
    fake.db.seed("motorist_call_legs", [
      { organization_id: "org", telnyx_call_control_id: "copied-prod", session_id: "copied" },
      { organization_id: "org", telnyx_call_control_id: "test-out", session_id: "test-session" },
    ]);
    fake.db.seed("motorist_telnyx_webhook_events", [
      { event_id: "foreign", organization_id: "org", call_control_id: "copied-prod", event_type: "call.initiated", connection_id: "prod-app" },
      { event_id: "own", organization_id: "org", call_control_id: "test-in", event_type: "call.initiated", connection_id: "test-app" },
    ]);
    fake.db.seed("motorist_provider_commands", [
      { command_id: "copied", session_id: "copied", method: "POST", path: "/calls", outcome: "accepted", request_payload: { connection_id: "prod-app" }, result: { data: { call_control_id: "copied-prod" } } },
      { command_id: "test", session_id: "test-session", method: "POST", path: "/calls", outcome: "accepted", request_payload: { connection_id: "test-app" }, result: { data: { call_control_id: "test-out" } } },
    ]);
    await expect(hasTestCallProvenance(boundary, "copied-prod")).resolves.toBe(false);
    await expect(hasTestCallProvenance(boundary, "unknown")).resolves.toBe(false);
    await expect(hasTestCallProvenance(boundary, "test-in")).resolves.toBe(true);
    await expect(hasTestCallProvenance(boundary, "test-out")).resolves.toBe(true);
  });
});
