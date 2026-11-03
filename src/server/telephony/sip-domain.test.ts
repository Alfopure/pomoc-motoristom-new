import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { completeAnnouncedAction } from "@/test/complete-call-announcements";
import { FAKE_TELNYX_ENV } from "@/test/fake-telnyx";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import { addCallParty, blindTransfer, callColleague, createRateLimiter, startConsult, startOutboundCall, superviseCall, type CallActor } from "./call-actions";
import { clearLatencyFlagsCache, defaultLatencyFlags, envLatencyFlags, freezeStartMode, readLatencyFlags, startSipDomain, type LatencyFlags } from "./latency-flags";
import { getWebphoneOfferStatus } from "./webphone-offer-status";
import { createTelnyxClient } from "./telnyx/client";
import { decodeClientState, encodeClientState } from "./telnyx/client-state";
import { getTelnyxConfig } from "./telnyx/env";
import { checkTestProviderRequest, testSipUsername, TestProviderSafetyError, type ProviderBoundary } from "./telnyx/test-safety";
import { isTelnyxSipUriOf, readMeta, sessionSipDomain, telnyxSipUri, telnyxSipUris, telnyxSipUsername, type SessionRow } from "./state/types";

/**
 * Call-speed S5 SIP-domain spike: a session frozen to the EU API region may
 * also be frozen to dial its operators' SIP credentials as
 * `sip:<user>@sip.telnyx.eu` (`sip_domain: "eu"`, TEST only). Every
 * SIP-credential dial of such a session uses it; every other session, and
 * every session created before, dials `sip.telnyx.com` exactly as before.
 * Whatever reads a SIP address back accepts both domains and nothing else.
 */

const o1: CallActor = { profileId: PROFILES.o1, role: "dispatcher", displayName: "Jana" };
const manager: CallActor = { profileId: PROFILES.o4, role: "manager", displayName: "Manažér" };
const EU: Partial<LatencyFlags> = { api_region: "eu", sip_domain: "eu" };
const COM_SIP = "sip:gencred001@sip.telnyx.com", EU_SIP = "sip:gencred001@sip.telnyx.eu";
/** The expected address, spelled out independently of the builder under test. */
const sip = (user: string, domain: "com" | "eu") => `sip:${user}@sip.telnyx.${domain}`;

beforeEach(() => clearLatencyFlagsCache());
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

let request = 0;
const requestId = () => `00000000-0000-4000-8000-${String(++request).padStart(12, "0")}`;

/** A contract-2 world; only an application environment of exactly `test` may freeze `eu`. */
function harness(flags: Partial<LatencyFlags> = {}, environment = "test") {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  vi.stubEnv("MOTORIST_APP_ENV", environment);
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  h.deps.latencyFlags = { ...defaultLatencyFlags(), ...flags };
  const deps = () => ({ ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) });
  return { h, deps };
}

const meta = (h: TelephonyHarness, sessionId: string) => readMeta(h.session(sessionId) as SessionRow);

/** Every SIP-credential destination sent to Telnyx (a dial or a transfer), with the intent its client state carries. */
function sipDestinations(h: TelephonyHarness, from = 0) {
  return h.telnyx.calls.slice(from).filter(call => (call.method === "dial" || call.method === "transfer") && telnyxSipUsername(call.params.to)).map(call => {
    const state = decodeClientState(call.method === "dial" ? call.params.clientState : call.params.targetLegClientState);
    return `${call.method}:${state?.intent ?? state?.role} ${String(call.params.to)}`;
  });
}

/** An outbound call through to both sides talking. */
async function outboundTalking(h: TelephonyHarness, deps: ReturnType<ReturnType<typeof harness>["deps"]>) {
  const call = await startOutboundCall(deps, o1, { to: NUMBERS.customer, requestId: requestId() });
  h.telnyx.physical.answered(call.operatorLegCallControlId);
  await h.legEvent(call.operatorLegCallControlId, "call.answered");
  const customer = String(h.legs(call.sessionId).find(leg => leg.role === "customer")!.telnyx_call_control_id);
  h.telnyx.physical.answered(customer);
  await h.legEvent(customer, "call.answered");
  await h.legEvent(customer, "call.bridged");
  await h.legEvent(call.operatorLegCallControlId, "call.bridged");
  expect(h.session(call.sessionId).state).toBe("talking");
  return { ...call, customer };
}

function seedSupervisorDevice(h: TelephonyHarness) {
  const seenAt = h.now().toISOString();
  h.db.seed("motorist_operator_devices", [{ organization_id: ORG, profile_id: PROFILES.o4, environment: "development", telnyx_credential_id: "cred-900",
    sip_username: "gencred900", credential_expires_at: null, last_token_issued_at: seenAt, token_expires_at: null, device_seen_at: seenAt,
    device_session_id: "dev-900", registration_state: "registered", user_agent: "vitest", metadata: {} }]);
}

describe("Telnyx SIP addresses", () => {
  it("are built on the session's domain and read back strictly on either", () => {
    expect(telnyxSipUri("gencred001", "com")).toBe(COM_SIP);
    expect(telnyxSipUri("gencred001", "eu")).toBe(EU_SIP);
    expect(telnyxSipUris("gencred001")).toEqual([COM_SIP, EU_SIP]);
    for (const uri of [COM_SIP, EU_SIP]) {
      expect(telnyxSipUsername(uri)).toBe("gencred001");
      expect(testSipUsername(uri)).toBe("gencred001");
      expect(isTelnyxSipUriOf(uri, "gencred001")).toBe(true);
      expect(isTelnyxSipUriOf(uri, "gencred002")).toBe(false);
    }
    for (const foreign of ["gencred001", "sip:gencred001@sip.telnyx.de", "sip:gencred001@sip.telnyx.eu.evil.test", "sip:gencred001@evil.sip.telnyx.eu",
      "sip:gencred001@sip.telnyx.eu;transport=tls", "sip:gencred001@sip.telnyx.eu:5060", "sips:gencred001@sip.telnyx.eu", "sip:gen%63red001@sip.telnyx.eu",
      "sip:gencred001@SIP.TELNYX.EU", " sip:gencred001@sip.telnyx.eu", "sip:a@b@sip.telnyx.eu", "sip:@sip.telnyx.eu", NUMBERS.customer, "", null, 42]) {
      expect(telnyxSipUsername(foreign), String(foreign)).toBeNull();
      expect(isTelnyxSipUriOf(foreign, "gencred001"), String(foreign)).toBe(false);
    }
  });

  it("follow the session's frozen domain on TEST; a session without one is `com` for good", () => {
    vi.stubEnv("MOTORIST_APP_ENV", "test");
    const frozen = { start_mode: { apiRegion: "eu", sipDomain: "eu" } };
    expect(sessionSipDomain(frozen)).toBe("eu");
    for (const metadata of [null, undefined, {}, [], "eu", { start_mode: null }, { start_mode: { apiRegion: "eu" } },
      { start_mode: { sipDomain: "com" } }, { start_mode: { sipDomain: "EU" } }]) expect(sessionSipDomain(metadata), JSON.stringify(metadata)).toBe("com");
    // Until the spike passes, nothing but TEST dials `eu`, even for a row frozen to it (a local run on the TEST database, a copied row).
    for (const env of [{ MOTORIST_APP_ENV: "production" }, { MOTORIST_APP_ENV: "", VERCEL_ENV: "production" }, { MOTORIST_APP_ENV: "development" },
      { MOTORIST_APP_ENV: "", VERCEL_ENV: "" }, { MOTORIST_APP_ENV: "staging" }]) {
      vi.unstubAllEnvs();
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      expect(sessionSipDomain(frozen), JSON.stringify(env)).toBe("com");
    }
  });

  it("are built only by the shared builder (static)", () => {
    const root = join(__dirname, "..", "..");
    const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === "test" && directory === root ? [] : sources(path);
      return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [path] : [];
    });
    // Comments may name the hosts; only code builds or matches them.
    const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
    const files = sources(root).map(path => ({ name: relative(root, path), text: code(readFileSync(path, "utf8")) }));
    // A Telnyx SIP host, as a string or a pattern, appears in the builder alone.
    expect(files.filter(({ text }) => /sip\\?\.telnyx/.test(text)).map(({ name }) => name)).toEqual(["server/telephony/state/types.ts"]);
    // Any other `sip:` URI built from parts is the AI demo's OpenAI target, never a Telnyx credential.
    const built = files.filter(({ text }) => /`sip:\$\{|["'`]sip:["'`]\s*\+/.test(text)).map(({ name }) => name).sort();
    expect(built).toEqual(["server/telephony/ai-demo/config.ts", "server/telephony/state/types.ts", "server/telephony/telnyx/test-safety.ts"]);
    for (const { name, text } of files.filter(({ name }) => built.includes(name) && name !== "server/telephony/state/types.ts")) {
      for (const match of text.matchAll(/`sip:\$\{[^`]*`/g)) expect(`${name}: ${match[0]}`).toMatch(/@\$\{(aiHost|sipHost)\};transport=tls`$/);
    }
    const builder = files.find(({ name }) => name === "server/telephony/state/types.ts")!.text;
    expect([...builder.matchAll(/`sip:\$\{[^`]*`/g)].map(match => match[0])).toEqual(["`sip:${sipUsername}@${TELNYX_SIP_HOSTS[domain]}`"]);
  });
});

describe("the sip_domain switch", () => {
  it("defaults to com, reads com and eu, and ignores anything else", () => {
    expect(defaultLatencyFlags().sip_domain).toBe("com");
    expect(envLatencyFlags({}).sip_domain).toBe("com");
    expect(envLatencyFlags({ TELEPHONY_LATENCY_FLAGS: JSON.stringify({ sip_domain: "eu" }) }).sip_domain).toBe("eu");
    expect(envLatencyFlags({ TELEPHONY_LATENCY_FLAGS: JSON.stringify({ sip_domain: "com" }) }).sip_domain).toBe("com");
    const problems: unknown[] = [];
    for (const value of ["us", "EU", "sip.telnyx.eu", true, null, 1]) {
      clearLatencyFlagsCache();
      expect(envLatencyFlags({ TELEPHONY_LATENCY_FLAGS: JSON.stringify({ sip_domain: value }) }, entry => problems.push(entry.problem)).sip_domain).toBe("com");
    }
    expect(new Set(problems)).toEqual(new Set(["env:sip_domain"]));
  });

  it("freezes `eu` only into a session we create in the EU API region, on TEST", () => {
    vi.stubEnv("MOTORIST_APP_ENV", "test");
    const start = (flags: Partial<LatencyFlags>, direction: "inbound" | "outbound" | "internal") =>
      freezeStartMode({ ...defaultLatencyFlags(), ...flags }, { direction, origin: direction === "inbound" ? null : "web", providerRegion: "us" });
    const sequential = { concurrent: false, autoBridge: false, ownLegTimeoutSecs: 30, origin: "web" };
    expect(start(EU, "outbound")).toEqual({ ...sequential, apiRegion: "eu", sipDomain: "eu" });
    expect(start(EU, "internal")).toEqual({ ...sequential, apiRegion: "eu", sipDomain: "eu" });
    // Telnyx created an inbound call, in the region the deployment calls (`us`).
    expect(start(EU, "inbound")).toEqual({ ...sequential, origin: null, apiRegion: "us" });
    // Never without the EU API region.
    expect(start({ sip_domain: "eu" }, "outbound")).toEqual({ ...sequential, apiRegion: "us" });
    // The default, with or without `eu`, records exactly what it did before: no field at all.
    expect(start({}, "outbound")).toEqual({ ...sequential, apiRegion: "us" });
    expect(start({ api_region: "eu" }, "internal")).toEqual({ ...sequential, apiRegion: "eu" });
  });

  it("never freezes `eu` from a deployment whose own host is `.eu`: not for an inbound call, nor without `api_region: \"eu\"`", () => {
    vi.stubEnv("MOTORIST_APP_ENV", "test");
    const start = (flags: Partial<LatencyFlags>, direction: "inbound" | "outbound" | "internal") =>
      freezeStartMode({ ...defaultLatencyFlags(), ...flags }, { direction, origin: direction === "inbound" ? null : "web", providerRegion: "eu" });
    // A test or local `TELNYX_API_BASE_URL` on `.eu` makes every session's region `eu`; the SIP domain still needs both switches and a call we create.
    for (const flags of [{ sip_domain: "eu" }, EU] as const) {
      const inbound = start(flags, "inbound");
      expect(inbound.apiRegion).toBe("eu");
      expect(inbound).not.toHaveProperty("sipDomain");
      expect(startSipDomain({ ...defaultLatencyFlags(), ...flags }, { direction: "inbound", providerRegion: "eu" })).toBe("com");
    }
    for (const direction of ["outbound", "internal"] as const) {
      expect(start({ sip_domain: "eu" }, direction)).toMatchObject({ apiRegion: "eu" });
      expect(start({ sip_domain: "eu" }, direction)).not.toHaveProperty("sipDomain");
      expect(start(EU, direction)).toMatchObject({ apiRegion: "eu", sipDomain: "eu" });
    }
  });

  it("never freezes `eu` in production, a local run, development or an unreadable environment", () => {
    const environments: Array<[string, Record<string, string>]> = [
      ["production", { MOTORIST_APP_ENV: "production" }],
      ["Vercel production", { MOTORIST_APP_ENV: "", VERCEL_ENV: "production" }],
      ["development", { MOTORIST_APP_ENV: "development" }],
      ["a local run", { MOTORIST_APP_ENV: "", VERCEL_ENV: "" }],
      ["an unreadable environment", { MOTORIST_APP_ENV: "staging" }],
    ];
    const flags = { ...defaultLatencyFlags(), ...EU };
    for (const [name, env] of environments) {
      vi.unstubAllEnvs();
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      for (const direction of ["outbound", "internal"] as const) {
        const frozen = freezeStartMode(flags, { direction, origin: "web", providerRegion: "us" });
        expect(frozen, name).not.toHaveProperty("sipDomain");
        expect(frozen.apiRegion, name).toBe("us");
        expect(startSipDomain(flags, { direction, providerRegion: "us" }), name).toBe("com");
      }
    }
  });

  it("decides a start's domain exactly as its session freezes it", () => {
    let checked = 0;
    for (const environment of ["test", "production", "development"]) {
      vi.stubEnv("MOTORIST_APP_ENV", environment);
      for (const api_region of ["us", "eu"] as const) for (const sip_domain of ["com", "eu"] as const) {
        const flags = { ...defaultLatencyFlags(), api_region, sip_domain };
        for (const direction of ["inbound", "outbound", "internal"] as const) for (const providerRegion of ["us", "eu"] as const) {
          const frozen = freezeStartMode(flags, { direction, origin: direction === "inbound" ? null : "web", providerRegion });
          expect(startSipDomain(flags, { direction, providerRegion })).toBe(frozen.sipDomain ?? "com");
          if (frozen.sipDomain) expect(frozen.apiRegion).toBe("eu");
          checked += 1;
        }
      }
    }
    expect(checked).toBe(72);
  });
});

describe("the SIP dials of a session", () => {
  it("rings the own leg and the colleague on sip.telnyx.eu in an `eu` colleague call, and records that address", async () => {
    const { h, deps } = harness(EU);
    const call = await callColleague(deps(), o1, { targetProfileId: PROFILES.o2, requestId: requestId() });
    const frozen = meta(h, call.sessionId);
    expect(frozen.start_mode).toMatchObject({ apiRegion: "eu", sipDomain: "eu" });
    expect(h.session(call.sessionId).called_number).toBe("sip:gencred002@sip.telnyx.eu");
    expect(frozen.internal).toMatchObject({ target_sip: "sip:gencred002@sip.telnyx.eu" });
    expect(frozen).toMatchObject({ initial_operation: { to: "sip:gencred002@sip.telnyx.eu", sipUri: EU_SIP } });
    h.telnyx.physical.answered(call.operatorLegCallControlId);
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    expect(sipDestinations(h)).toEqual([`dial:internal_caller ${EU_SIP}`, "dial:internal sip:gencred002@sip.telnyx.eu"]);
    expect(h.legs(call.sessionId).map(leg => leg.to_number).sort()).toEqual([EU_SIP, "sip:gencred002@sip.telnyx.eu"]);
    // The frozen mode never changes afterwards.
    expect(meta(h, call.sessionId).start_mode).toEqual(frozen.start_mode);
  });

  it("rings both endpoints of a colleague with web and mobile on sip.telnyx.eu", async () => {
    const { h, deps } = harness(EU);
    for (const [key, value] of Object.entries({ APP_BASE_URL: "https://test.dispecing.linkapomoci.sk", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
      VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co", MOTORIST_NATIVE_VOICE_TEST_ENABLED: "true" })) vi.stubEnv(key, value);
    h.db.seed("motorist_operator_mobile_devices", [{ organization_id: ORG, profile_id: PROFILES.o2, environment: "development", sip_username: "native-colleague",
      device_session_id: "00000000-0000-4000-8000-000000009001", device_seen_at: h.now().toISOString(), registration_state: "registered" }]);
    const call = await callColleague(deps(), o1, { targetProfileId: PROFILES.o2, requestId: requestId() });
    expect(meta(h, call.sessionId).internal?.endpoints).toEqual([{ device: "web", sipUri: "sip:gencred002@sip.telnyx.eu" },
      { device: "mobile", sipUri: "sip:native-colleague@sip.telnyx.eu" }]);
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    expect(sipDestinations(h).sort()).toEqual([`dial:internal_caller ${EU_SIP}`, "dial:internal sip:gencred002@sip.telnyx.eu",
      "dial:internal sip:native-colleague@sip.telnyx.eu"].sort());
  });

  it.each([
    ["a blind transfer", (deps: Parameters<typeof blindTransfer>[0], sessionId: string) => blindTransfer(deps, o1, sessionId, { profileId: PROFILES.o2 }), "dial:transfer_safe"],
    ["a consult", (deps: Parameters<typeof startConsult>[0], sessionId: string) => startConsult(deps, o1, sessionId, { profileId: PROFILES.o2 }), "dial:consult"],
    ["an added party", (deps: Parameters<typeof addCallParty>[0], sessionId: string) => addCallParty(deps, o1, sessionId, { profileId: PROFILES.o2 }), "dial:party"],
    ["a supervisor", (deps: Parameters<typeof superviseCall>[0], sessionId: string) => superviseCall(deps, manager, sessionId, "monitor"), "dial:supervise"],
  ])("dials %s to a colleague on the outbound session's domain", async (_case, action, kind) => {
    for (const [flags, domain] of [[EU, "eu"], [{ sip_domain: "eu" }, "com"], [{}, "com"]] as const) {
      const { h, deps } = harness(flags);
      seedSupervisorDevice(h);
      const call = await outboundTalking(h, deps());
      expect(sessionSipDomain(h.session(call.sessionId).metadata)).toBe(domain);
      const from = h.telnyx.calls.length;
      await completeAnnouncedAction(h, action(deps(), call.sessionId));
      const user = kind === "dial:supervise" ? "gencred900" : "gencred002";
      expect(sipDestinations(h)[0], JSON.stringify(flags)).toBe(`dial:outbound ${sip("gencred001", domain)}`);
      expect(sipDestinations(h, from), JSON.stringify(flags)).toEqual([`${kind} ${sip(user, domain)}`]);
      expect(h.legs(call.sessionId).filter(leg => leg.profile_id === (kind === "dial:supervise" ? PROFILES.o4 : PROFILES.o2)).map(leg => leg.to_number))
        .toEqual([sip(user, domain)]);
    }
  });

  it("transfers through Telnyx's own transfer on the session's domain when the server does not control the transfer", async () => {
    const { h, deps } = harness(EU);
    const call = await outboundTalking(h, deps());
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
    // A session row without the stability contract hands the customer to Telnyx's transfer.
    h.db.update("motorist_call_sessions", { metadata: Object.fromEntries(Object.entries(h.session(call.sessionId).metadata as Record<string, unknown>)
      .filter(([key]) => key !== "effects_v1")), pending_effects: null, presence_pickup: null }, row => row.id === call.sessionId);
    const from = h.telnyx.calls.length;
    await completeAnnouncedAction(h, blindTransfer(deps(), o1, call.sessionId, { profileId: PROFILES.o2 }));
    expect(sipDestinations(h, from)).toEqual(["transfer:transfer sip:gencred002@sip.telnyx.eu"]);
  });

  it.each([[EU, {}, "eu"], [{}, EU, "com"]] as const)("keeps a session on the domain it was created with when the switch flips (%j → %j)", async (before, after, domain) => {
    const { h, deps } = harness(before);
    const call = await outboundTalking(h, deps());
    h.deps.latencyFlags = { ...defaultLatencyFlags(), ...after };
    const from = h.telnyx.calls.length;
    await completeAnnouncedAction(h, startConsult(deps(), o1, call.sessionId, { profileId: PROFILES.o2 }));
    expect(sipDestinations(h, from)).toEqual([`dial:consult ${sip("gencred002", domain)}`]);
    expect(sessionSipDomain(h.session(call.sessionId).metadata)).toBe(domain);
  });

  it("rings an inbound call's operators on sip.telnyx.com, even on a deployment whose own host is `.eu` with both switches on", async () => {
    const { h } = harness(EU);
    if (!h.deps.config.configured) throw new Error("configured fixture required");
    h.deps.config = { ...h.deps.config, apiBaseUrl: "https://api.telnyx.eu/v2" };
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(meta(h, call.sessionId).start_mode).toMatchObject({ apiRegion: "eu" });
    expect(meta(h, call.sessionId).start_mode).not.toHaveProperty("sipDomain");
    const ring = sipDestinations(h).filter(entry => entry.startsWith("dial:ring "));
    expect(ring.length).toBeGreaterThan(0);
    expect(ring.every(entry => entry.endsWith("@sip.telnyx.com")), ring.join(", ")).toBe(true);
  });

  it("dials exactly as before with the default switch", async () => {
    const { h, deps } = harness();
    const call = await callColleague(deps(), o1, { targetProfileId: PROFILES.o2, requestId: requestId() });
    expect(meta(h, call.sessionId).start_mode).toEqual({ concurrent: false, autoBridge: false, ownLegTimeoutSecs: 30, apiRegion: "us", origin: "web" });
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    expect(sipDestinations(h)).toEqual([`dial:internal_caller ${COM_SIP}`, "dial:internal sip:gencred002@sip.telnyx.com"]);
    expect(h.telnyx.of("dial")[0].params.to).toBe(COM_SIP);
  });

  it.each([["test", "eu"], ["production", "com"], ["development", "com"]] as const)("a call started from the database flags on a %s deployment dials %s", async (environment, domain) => {
    const { h } = harness({}, environment);
    h.db.update("motorist_telephony_settings", { latency_flags: { api_region: "eu", sip_domain: "eu" } }, () => true);
    const latencyFlags = await readLatencyFlags(h.admin, ORG, { logger: () => undefined, env: {} });
    expect(latencyFlags).toMatchObject({ api_region: "eu", sip_domain: "eu" });
    const call = await startOutboundCall({ ...h.deps, latencyFlags, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) }, o1, { to: NUMBERS.customer, requestId: requestId() });
    expect(sessionSipDomain(h.session(call.sessionId).metadata)).toBe(domain);
    expect(sipDestinations(h)).toEqual([`dial:outbound ${sip("gencred001", domain)}`]);
  });

  it("creates nothing when the domain a start built its addresses with is not the one its session would freeze", async () => {
    const { h, deps } = harness(EU);
    const admin = h.deps.admin;
    // The environment changes after the start chose `eu` and before its session is frozen.
    const changing = { ...deps(), admin: new Proxy(admin, { get(target, property, receiver) {
      if (property !== "from") return Reflect.get(target, property, receiver);
      return (table: string) => {
        if (table === "motorist_operator_devices") vi.stubEnv("MOTORIST_APP_ENV", "production");
        return target.from(table as never);
      };
    } }) };
    await expect(startOutboundCall(changing, o1, { to: NUMBERS.customer, requestId: requestId() })).rejects.toMatchObject({ status: 500, code: "start_mode_changed" });
    expect(h.rows("motorist_call_sessions")).toEqual([]);
    expect(h.telnyx.of("dial")).toEqual([]);
  });
});

describe("reading SIP addresses back", () => {
  const boundary: ProviderBoundary = { callControlAppId: "app-test", credentialConnectionId: "cred-connection-test", messagingProfileId: null,
    safety: { restricted: true, deploymentAllowed: true, enabled: true, allowedNumbers: [], fromNumbers: [NUMBERS.allianz], allowAnyPhoneNumber: true } };
  const dialBody = (to: string) => ({ to, from: NUMBERS.allianz, connection_id: "app-test" });

  it("lets the TEST guard read the identity on either domain, and nothing else as a SIP identity", () => {
    expect(checkTestProviderRequest(boundary, "POST", "/calls", dialBody(EU_SIP)).sipUsernames).toEqual(["gencred001"]);
    expect(checkTestProviderRequest(boundary, "POST", "/calls", dialBody(COM_SIP)).sipUsernames).toEqual(["gencred001"]);
    for (const foreign of ["sip:gencred001@sip.telnyx.eu;transport=tls", "sip:gencred001@evil.sip.telnyx.eu", "sip:gencred001@sip.telnyx.eu.evil.test", "sip:gencred001@sip.telnyx.de"]) {
      expect(() => checkTestProviderRequest(boundary, "POST", "/calls", dialBody(foreign)), foreign).toThrow(TestProviderSafetyError);
    }
  });

  it("lets the TEST client dial an enrolled identity on both domains and refuses a foreign one on both", async () => {
    const env = { ...FAKE_TELNYX_ENV, MOTORIST_APP_ENV: "test", MOTORIST_TEST_LIVE_INTEGRATIONS: "true",
      MOTORIST_TEST_ALLOW_ANY_PHONE_NUMBER: "true", MOTORIST_TEST_FROM_NUMBERS: NUMBERS.allianz, VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
      VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co", APP_BASE_URL: "https://test.dispecing.linkapomoci.sk" };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
    h.db.update("motorist_profiles", { kind: "human" }, () => true);
    const sent: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace(/^\/v2/, "");
      if (path.startsWith("/telephony_credentials/")) {
        return new Response(JSON.stringify({ data: { resource_id: "connection:cred-connection-test", expired: false, sip_username: "gencred001" } }), { status: 200 });
      }
      if (options?.method === "POST" && path === "/calls") sent.push(String(JSON.parse(String(options.body)).to));
      return new Response(JSON.stringify({ data: { call_control_id: `leg-${sent.length}`, call_leg_id: `leg-id-${sent.length}`, call_session_id: "provider-session" } }), { status: 200 });
    });
    const config = getTelnyxConfig({ ...env, TELNYX_CALL_CONTROL_APP_ID: "app-test", TELNYX_CREDENTIAL_CONNECTION_ID: "cred-connection-test" });
    const client = createTelnyxClient({ config, fetch, liveGate: { callsEnabled: true, smsEnabled: false }, testProvenanceContext: { admin: h.admin, organizationId: ORG } });
    const dial = (to: string, commandId: string) => client.dial({ commandId, to, from: NUMBERS.allianz, clientState: "e30=", timeoutSecs: 30 });
    await expect(client.proveSipDestination!(EU_SIP)).resolves.toBe("proven");
    await dial(EU_SIP, "eu");
    await dial(COM_SIP, "com");
    expect(sent).toEqual([EU_SIP, COM_SIP]);
    for (const foreign of ["sip:stranger@sip.telnyx.eu", "sip:stranger@sip.telnyx.com", "sip:gencred001@sip.telnyx.eu;transport=tls"]) {
      await expect(dial(foreign, `foreign-${foreign}`), foreign).rejects.toMatchObject({ code: "test_provider_boundary" });
    }
    expect(sent).toHaveLength(2);
  });

  it("answers a browser's offer status for its own leg on either domain, and refuses another identity", async () => {
    const { h, deps } = harness(EU);
    const call = await callColleague(deps(), o1, { targetProfileId: PROFILES.o2, requestId: requestId() });
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    const target = h.openLegFor(call.sessionId, PROFILES.o2)!;
    expect(target.to_number).toBe("sip:gencred002@sip.telnyx.eu");
    const status = () => getWebphoneOfferStatus(h.deps, PROFILES.o2, { deviceSessionId: "dev-2", callControlId: String(target.telnyx_call_control_id) });
    await expect(status()).resolves.toMatchObject({ sessionId: call.sessionId });
    h.db.update("motorist_call_legs", { to_number: "sip:gencred002@sip.telnyx.com" }, row => row.id === target.id);
    await expect(status()).resolves.toMatchObject({ sessionId: call.sessionId });
    for (const foreign of ["sip:gencred001@sip.telnyx.eu", "sip:gencred002@sip.telnyx.de", "gencred002"]) {
      h.db.update("motorist_call_legs", { to_number: foreign }, row => row.id === target.id);
      await expect(status(), foreign).rejects.toMatchObject({ status: 403 });
    }
  });

  describe("a credential-side mirror of an `eu` session's dial", () => {
    async function mirrorFixture() {
      const { h, deps } = harness(EU);
      const call = await callColleague(deps(), o1, { targetProfileId: PROFILES.o2, requestId: requestId() });
      if (!h.deps.config.configured) throw new Error("configured fixture required");
      const operator = h.legFor(call.sessionId, PROFILES.o1)!;
      const telnyxSessionId = call.telnyxSessionId!;
      expect(telnyxSessionId).toBeTruthy();
      expect(operator.to_number).toBe(EU_SIP);
      // The real HTTP /calls journal row of the own leg's dial, as the processor proves it.
      const journal = (to: string) => h.db.insert("motorist_provider_commands", {
        session_id: call.sessionId, command_id: `mirror-proof-dial-${to}`, method: "POST", path: "/calls", outcome: "accepted", http_status: 200,
        first_dispatched_at: h.now().toISOString(),
        request_payload: { connection_id: h.deps.config.configured ? h.deps.config.callControlAppId : "", to, from: operator.from_number,
          client_state: encodeClientState({ sid: call.sessionId, role: "operator", operatorId: PROFILES.o1 }) },
        result: { data: { call_control_id: operator.telnyx_call_control_id, call_leg_id: operator.telnyx_call_leg_id, call_session_id: telnyxSessionId } },
      });
      let id = 0;
      const envelope = (to: string) => h.envelope("call.initiated", {
        connection_id: h.deps.config.configured ? h.deps.config.credentialConnectionId : "", call_session_id: telnyxSessionId,
        call_control_id: `browser-counterpart-${++id}`, call_leg_id: `browser-counterpart-leg-${id}`, to, from: operator.from_number,
        client_state: null, direction: "incoming", state: "bridging" }, `mirror-${id}`);
      return { h, call, journal, envelope };
    }

    it.each([["the bare username", "gencred001"], ["its EU SIP address", EU_SIP], ["its .com SIP address", COM_SIP]])("is proven when Telnyx names %s, and logged for the spike", async (_name, to) => {
      const { h, call, journal, envelope } = await mirrorFixture();
      journal(EU_SIP);
      expect(await h.process(envelope(to))).toMatchObject({ status: 200, outcome: "ignored", sessionId: call.sessionId, notes: ["verified credential browser mirror"] });
      expect(h.logs.filter(entry => entry.scope === "sip-domain-spike" && entry.source === "mirror")).toEqual([
        expect.objectContaining({ sessionId: call.sessionId, type: "call.initiated", direction: "incoming", to, sipTo: null, payloadKeys: expect.arrayContaining(["to"]) })]);
    });

    it.each([["a foreign SIP domain", "sip:gencred001@foreign.test"], ["another identity", "sip:gencred002@sip.telnyx.eu"], ["URI parameters", `${EU_SIP};transport=tls`]])(
      "is not proven for %s", async (_name, to) => {
        const { h, journal, envelope } = await mirrorFixture();
        journal(EU_SIP);
        expect((await h.process(envelope(to))).notes).not.toContain("verified credential browser mirror");
      });

    it("is proven only by a dial to the address the session really dialled", async () => {
      const { h, journal, envelope } = await mirrorFixture();
      journal(COM_SIP);
      expect((await h.process(envelope("gencred001"))).notes).not.toContain("verified credential browser mirror");
    });
  });

  it("logs what Telnyx names on an `eu` session's own events, never a phone number, and nothing for a `com` session", async () => {
    for (const [flags, logged] of [[EU, true], [{}, false]] as const) {
      const { h, deps } = harness(flags);
      const call = await outboundTalking(h, deps());
      const spike = h.logs.filter(entry => entry.scope === "sip-domain-spike");
      if (!logged) { expect(spike).toEqual([]); continue; }
      expect(spike.length).toBeGreaterThan(0);
      expect(spike.every(entry => entry.source === "session" && entry.sessionId === call.sessionId)).toBe(true);
      expect(spike.map(entry => entry.to)).toContain(EU_SIP);
      expect(JSON.stringify(spike)).not.toContain(NUMBERS.customer);
    }
  });

  it("logs only a credential's own name as it is, anything else by its shape without its user part", async () => {
    const { h, deps } = harness(EU);
    const call = await outboundTalking(h, deps());
    const logged: unknown[] = [];
    const shapes = async (to: unknown, sipTo?: unknown) => {
      h.logs.length = 0;
      await h.legEvent(call.operatorLegCallControlId, "call.answered", { to, ...(sipTo === undefined ? {} : { sip_to: sipTo }) }, `spike-${h.nextEventId()}`);
      const spike = h.logs.filter(entry => entry.scope === "sip-domain-spike");
      logged.push(...spike);
      return spike.map(entry => ({ to: entry.to, sipTo: entry.sipTo }));
    };
    expect(await shapes("gencred001", COM_SIP)).toEqual([{ to: "gencred001", sipTo: COM_SIP }]);
    expect(await shapes(EU_SIP)).toEqual([{ to: EU_SIP, sipTo: null }]);
    expect(await shapes("sip:secret-user@sip.telnyx.eu;transport=tls", "secret-user@Example.Test:5061")).toEqual([{
      to: { shape: "address", scheme: "sip", host: "sip.telnyx.eu", hasUser: true, hasParams: true },
      sipTo: { shape: "address", scheme: null, host: "example.test:5061", hasUser: true, hasParams: false } }]);
    expect(await shapes("sip:+421905123456@sip.telnyx.eu", NUMBERS.customer)).toEqual([{
      to: { shape: "address", scheme: "sip", host: "sip.telnyx.eu", hasUser: true, hasParams: false }, sipTo: { shape: "number" } }]);
    expect(await shapes("secret.dotted-user", "tel:+421905123456")).toEqual([{
      to: { shape: "address", scheme: null, host: null, hasUser: false, hasParams: false },
      sipTo: { shape: "address", scheme: "tel", host: null, hasUser: false, hasParams: false } }]);
    // Phone numbers only (a customer's leg): nothing at all.
    expect(await shapes(NUMBERS.customer, "421905123456")).toEqual([]);
    expect(JSON.stringify(logged)).not.toMatch(/secret|905123456/);
  });
});
