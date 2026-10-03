import { canOperateTelephony, isTestLiveDeployment, resolveAppEnvironment, TEST_APP_ORIGIN, TEST_SUPABASE_REF } from "@/lib/app-environment";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export type TestProviderSafety = { restricted: boolean; deploymentAllowed: boolean; enabled: boolean; allowedNumbers: readonly string[]; fromNumbers: readonly string[]; allowAnyPhoneNumber?: boolean; aiSipTarget?: string | null; smsAlphaSender?: string | null; smsAllowAnyRecipient?: boolean };
const E164 = /^\+[1-9]\d{7,14}$/;
const SIP = /^sip:([a-zA-Z0-9_-]{1,128})@sip\.telnyx\.com$/;

function numbers(value: string | undefined): string[] {
  const entries = value?.split(",").map(item => item.trim()) ?? [];
  return entries.length > 0 && entries.length <= 50 && entries.every(item => E164.test(item)) ? [...new Set(entries)] : [];
}

/** Invalid or partly configured TEST boundaries never become an unrestricted provider. */
export function getTestProviderSafety(env: Record<string, string | undefined> = process.env): TestProviderSafety {
  let restricted = true;
  const usesTestDatabase = [env.SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_URL].some(value => {
    try { return new URL(value ?? "").hostname === `${TEST_SUPABASE_REF}.supabase.co`; } catch { return false; }
  }) || [env.SUPABASE_PROJECT_REF, env.EXPECTED_SUPABASE_PROJECT_REF].includes(TEST_SUPABASE_REF);
  try { restricted = usesTestDatabase || resolveAppEnvironment(env) === "test" || !canOperateTelephony(env); } catch { /* fail closed */ }
  const allowedNumbers = numbers(env.MOTORIST_TEST_ALLOWED_NUMBERS);
  const fromNumbers = numbers(env.MOTORIST_TEST_FROM_NUMBERS);
  const alpha = env.MOTORIST_TEST_SMS_ALPHA_SENDER ?? "";
  const smsAlphaSender = /^[A-Za-z0-9]{3,11}$/.test(alpha) && /[A-Za-z]/.test(alpha) ? alpha : null;
  const aiProject = env.OPENAI_LIVE_PROJECT_ID?.trim() ?? "";
  const aiHost = env.OPENAI_LIVE_SIP_HOST?.trim() || "sip.api.openai.com";
  const aiSipTarget = env.AI_DEMO_ENABLED?.trim().toLowerCase() === "true" && /^proj_[A-Za-z0-9_-]{1,128}$/.test(aiProject) &&
    ["sip.api.openai.com", "sip-eu.api.openai.com"].includes(aiHost) ? `sip:${aiProject}@${aiHost};transport=tls` : null;
  const deploymentAllowed = isTestLiveDeployment(env);
  const allowAnyPhoneNumber = deploymentAllowed && env.MOTORIST_TEST_ALLOW_ANY_PHONE_NUMBER === "true";
  return { restricted, deploymentAllowed, allowedNumbers, fromNumbers, allowAnyPhoneNumber,
    smsAllowAnyRecipient: deploymentAllowed && env.MOTORIST_TEST_SMS_ALLOW_ANY_RECIPIENT === "true",
    aiSipTarget, smsAlphaSender,
    enabled: deploymentAllowed && env.MOTORIST_TEST_LIVE_INTEGRATIONS === "true" &&
      (allowAnyPhoneNumber || allowedNumbers.length > 0) && fromNumbers.length > 0 };
}

export function allowsUnlistedTestSmsRecipient(safety: TestProviderSafety | undefined, destination: string): boolean {
  return safety?.restricted === true && safety.deploymentAllowed && safety.enabled &&
    safety.smsAllowAnyRecipient === true && E164.test(destination);
}

export class TestProviderSafetyError extends Error {
  readonly code = "test_provider_boundary";
  readonly status = 423;
  constructor() { super("TEST provider operation is outside the approved boundary."); this.name = "TestProviderSafetyError"; }
}

export type ProviderBoundary = {
  safety: TestProviderSafety;
  callControlAppId: string | null;
  credentialConnectionId: string | null;
  messagingProfileId: string | null;
};

export function assertTestProviderEnabled(boundary: ProviderBoundary): void {
  if (!boundary.safety.restricted) return;
  if (!boundary.safety.enabled || !boundary.callControlAppId || !boundary.credentialConnectionId ||
    boundary.callControlAppId === boundary.credentialConnectionId) throw new TestProviderSafetyError();
}

/** Missing connection IDs on terminal/conference callbacks still require the processor's exact stored-session correlation. */
export function acceptsTestProviderEvent(boundary: ProviderBoundary, event: { type: string; connectionId: string | null; direction: string | null; from: string | null; to: string | null }): boolean {
  if (!boundary.safety.restricted) return true;
  if (!boundary.safety.deploymentAllowed) return false;
  if (event.connectionId && event.connectionId !== boundary.callControlAppId && event.connectionId !== boundary.credentialConnectionId) return false;
  if (event.type !== "call.initiated") return true;
  try { assertTestProviderEnabled(boundary); } catch { return false; }
  if (!event.connectionId) return false;
  if (event.direction === "incoming" && event.connectionId === boundary.callControlAppId) {
    // Signed ingress on our application and DID establishes ownership. Caller
    // identity may be withheld; it is not an outbound destination to validate.
    return (boundary.safety.allowAnyPhoneNumber === true || boundary.safety.allowedNumbers.includes(event.from ?? "")) &&
      boundary.safety.fromNumbers.includes(event.to ?? "");
  }
  return true;
}

const CALL_LIFECYCLE = new Set(["answer", "hangup", "bridge", "gather", "gather_using_audio", "gather_using_speak", "gather_stop", "speak", "playback_start", "playback_stop", "record_start", "record_stop", "send_dtmf", "switch_supervisor_role"]);
const CONFERENCE_LIFECYCLE = new Set(["join", "leave", "hold", "unhold", "mute", "unmute", "end", "play", "stop", "speak", "update", "send_dtmf", "gather_using_audio"]);
// TEST admits only fields used by our reviewed dial adapter. Provider additions
// such as nested conference joins/forwarding cannot silently bypass target checks through extra/request().
const TEST_DIAL_FIELDS = new Set(["to", "from", "connection_id", "client_state", "link_to", "timeout_secs", "time_limit_secs", "from_display_name",
  "sip_region", "media_encryption", "bridge_intent", "bridge_on_answer", "prevent_double_bridge", "custom_headers", "supervise_call_control_id", "supervisor_role",
  "webhook_url", "command_id", "sip_transport_protocol", "send_silence_when_idle", "park_after_unbridge"]);

/** Inspect the final wire payload, including generic request(), batches and dial.extra. */
export function checkTestProviderRequest(boundary: ProviderBoundary, method: string, path: string, body: Record<string, unknown> = {}): { sipUsernames: string[]; callIds: string[]; conferenceIds: string[]; credentialId?: string } {
  const checked: { sipUsernames: string[]; callIds: string[]; conferenceIds: string[]; credentialId?: string } = { sipUsernames: [], callIds: [], conferenceIds: [] };
  if (!boundary.safety.restricted || method === "GET") return checked;
  if (!boundary.safety.deploymentAllowed) throw new TestProviderSafetyError();
  if (!path.startsWith("/") || path.includes("..") || /[?#]/.test(path)) throw new TestProviderSafetyError();
  // The app joins conferences through separately scoped commands. Telnyx's
  // nested dial conference_config can otherwise attach a new leg to a foreign conference.
  if ("conference_config" in body) throw new TestProviderSafetyError();
  if (method === "POST" && path === "/calls" && Object.keys(body).some(key => !TEST_DIAL_FIELDS.has(key))) throw new TestProviderSafetyError();
  // Direct outbound keeps this leg parked after its linked browser leaves.
  // Admit only our adapter's form; link_to still requires TEST call provenance.
  if (method === "POST" && path === "/calls" && "park_after_unbridge" in body &&
    (body.park_after_unbridge !== "self" || typeof body.link_to !== "string" || !body.link_to)) throw new TestProviderSafetyError();
  const callId = /^\/calls\/([^/]+)\/actions\//.exec(path)?.[1];
  const conferenceId = /^\/conferences\/([^/]+)\/actions\//.exec(path)?.[1];
  if (callId) checked.callIds.push(decodeURIComponent(callId));
  if (conferenceId) checked.conferenceIds.push(decodeURIComponent(conferenceId));
  for (const [key, value] of Object.entries(body)) {
    if (!/(^|_)call_control_ids?$/.test(key) && key !== "link_to" && key !== "conference_id") continue;
    const ids = Array.isArray(value) ? value : [value];
    if (ids.length > 50 || ids.some(id => typeof id !== "string" || !id || id.length > 1024)) throw new TestProviderSafetyError();
    (key === "conference_id" ? checked.conferenceIds : checked.callIds).push(...ids as string[]);
  }
  for (const key of ["webhook_url", "webhook_url_method", "webhook_failover_url"]) {
    if (!(key in body)) continue;
    if (key === "webhook_url_method") { if (body[key] !== "POST") throw new TestProviderSafetyError(); continue; }
    const expectedPath = path === "/messages" ? "/api/sms/telnyx/webhook" : "/api/telephony/telnyx/webhook";
    if (body[key] !== `${TEST_APP_ORIGIN}${expectedPath}`) throw new TestProviderSafetyError();
  }
  // Revocation and existing-call lifecycle remain available after the creation kill switch is disabled.
  const revoke = /^\/telephony_credentials\/([^/]+)$/.exec(path);
  if (method === "DELETE" && revoke) {
    if (!boundary.credentialConnectionId) throw new TestProviderSafetyError();
    checked.credentialId = decodeURIComponent(revoke[1]);
    return checked;
  }
  const callAction = /^\/calls\/[^/]+\/actions\/([^/]+)$/.exec(path)?.[1];
  const conferenceAction = /^\/conferences\/[^/]+\/actions\/([^/]+)$/.exec(path)?.[1];
  const lifecycle = method === "POST" && (CALL_LIFECYCLE.has(callAction ?? "") || CONFERENCE_LIFECYCLE.has(conferenceAction ?? "") || path === "/conferences");
  if (lifecycle && !["to", "from", "connection_id", "participants"].some(key => key in body)) return checked;
  assertTestProviderEnabled(boundary);
  const token = /^\/telephony_credentials\/([^/]+)\/token$/.exec(path);
  if (method === "POST" && token) { checked.credentialId = decodeURIComponent(token[1]); return checked; }
  if (method === "POST" && path === "/telephony_credentials") {
    if (body.connection_id !== boundary.credentialConnectionId) throw new TestProviderSafetyError();
    return checked;
  }
  if (method !== "POST" || !(path === "/calls" || path === "/messages" || callAction === "transfer" || conferenceAction === "add_participants")) throw new TestProviderSafetyError();
  if (path === "/calls" && body.connection_id !== boundary.callControlAppId) throw new TestProviderSafetyError();
  if (path === "/messages" && (!boundary.messagingProfileId || body.messaging_profile_id !== boundary.messagingProfileId)) throw new TestProviderSafetyError();
  const approvedAlpha = path === "/messages" && boundary.safety.smsAlphaSender != null && body.from === boundary.safety.smsAlphaSender;
  if (typeof body.from !== "string" || (!boundary.safety.fromNumbers.includes(body.from) && !approvedAlpha)) throw new TestProviderSafetyError();
  const destinations = Array.isArray(body.to) ? body.to : [body.to];
  if (!destinations.length || destinations.length > 50) throw new TestProviderSafetyError();
  for (const destination of destinations) {
    if (typeof destination !== "string") throw new TestProviderSafetyError();
    if (path === "/calls" && destination === boundary.safety.aiSipTarget) continue;
    const sip = path !== "/messages" ? SIP.exec(destination) : null;
    if (sip) checked.sipUsernames.push(sip[1]);
    else if (!boundary.safety.allowedNumbers.includes(destination) &&
      !(boundary.safety.allowAnyPhoneNumber === true && E164.test(destination)) &&
      !(path === "/messages" && allowsUnlistedTestSmsRecipient(boundary.safety, destination))) throw new TestProviderSafetyError();
  }
  return checked;
}

export function acceptsTestInboundSms(safety: TestProviderSafety, from: unknown, recipients: unknown[]): boolean {
  if (!safety.restricted) return true;
  return safety.deploymentAllowed && safety.enabled && typeof from === "string" &&
    (safety.allowedNumbers.includes(from) || safety.allowAnyPhoneNumber === true && E164.test(from)) &&
    recipients.length > 0 && recipients.length <= 50 && recipients.every(number => typeof number === "string" && safety.fromNumbers.includes(number));
}

/** A copied call/session row is not evidence. Only signed TEST ingress or an accepted TEST dial establishes ownership. */
export async function hasTestCallProvenance(boundary: ProviderBoundary, callControlId: string, context?: { admin: SupabaseClient<Database>; organizationId: string }): Promise<boolean> {
  const admin = context?.admin ?? (await import("@/lib/supabase/admin")).createSupabaseAdminClient();
  const signal = AbortSignal.timeout(1500);
  let organizationId = context?.organizationId;
  if (!organizationId) {
    const organization = await admin.from("motorist_organizations").select("id")
      .eq("slug", process.env.MOTORIST_ORGANIZATION_SLUG?.trim() || "pomoc-motoristom").eq("active", true).abortSignal(signal).maybeSingle();
    if (organization.error || !organization.data) throw new TestProviderSafetyError();
    organizationId = organization.data.id;
  }
  const ledger = await admin.from("motorist_telnyx_webhook_events").select("event_id")
    .eq("organization_id", organizationId).eq("call_control_id", callControlId).eq("event_type", "call.initiated")
    .in("connection_id", [boundary.callControlAppId, boundary.credentialConnectionId].filter((id): id is string => Boolean(id))).limit(1).abortSignal(signal);
  if (ledger.error) throw new TestProviderSafetyError();
  if (ledger.data?.length) return true;
  const leg = await admin.from("motorist_call_legs").select("session_id").eq("organization_id", organizationId)
    .eq("telnyx_call_control_id", callControlId).limit(1).abortSignal(signal).maybeSingle();
  if (leg.error) throw new TestProviderSafetyError();
  if (!leg.data || !boundary.callControlAppId) return false;
  const command = await admin.from("motorist_provider_commands").select("command_id").eq("session_id", leg.data.session_id)
    .eq("method", "POST").eq("path", "/calls").eq("outcome", "accepted")
    .contains("request_payload", { connection_id: boundary.callControlAppId }).contains("result", { data: { call_control_id: callControlId } })
    .limit(1).abortSignal(signal);
  if (command.error) throw new TestProviderSafetyError();
  return Boolean(command.data?.length);
}

/** Resolve only an enrolled TEST browser/mobile identity; never accept arbitrary sip.telnyx.com users. */
export async function resolveTestSipCredential(sipUsername: string): Promise<string> {
  const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
  const admin = createSupabaseAdminClient();
  const signal = AbortSignal.timeout(1500);
  const organization = await admin.from("motorist_organizations").select("id")
    .eq("slug", process.env.MOTORIST_ORGANIZATION_SLUG?.trim() || "pomoc-motoristom").eq("active", true).abortSignal(signal).maybeSingle();
  if (organization.error || !organization.data) throw new TestProviderSafetyError();
  const ids = new Set<string>();
  for (const table of ["motorist_operator_devices", "motorist_operator_mobile_devices"] as const) {
    const { data, error } = await admin.from(table).select("telnyx_credential_id,profile_id")
      .eq("organization_id", organization.data.id).eq("environment", "development").eq("sip_username", sipUsername).limit(2).abortSignal(signal);
    if (error) throw new TestProviderSafetyError();
    for (const row of data ?? []) {
      const profile = await admin.from("motorist_profiles").select("id").eq("id", row.profile_id).eq("organization_id", organization.data.id)
        .eq("active", true).eq("access_status", "active").eq("kind", "human").abortSignal(signal).maybeSingle();
      if (profile.error || !profile.data) throw new TestProviderSafetyError();
      if (row.telnyx_credential_id) ids.add(row.telnyx_credential_id);
    }
  }
  if (ids.size !== 1) throw new TestProviderSafetyError();
  return [...ids][0];
}
