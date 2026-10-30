import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as upload } from "@/app/api/mobile/v1/diagnostics/voice/route";
import { MutationError } from "@/server/mutation-error";
import { takeVoiceDiagnosticsToken, VOICE_DIAGNOSTIC_EVENTS, VOICE_DIAGNOSTIC_KEYS } from "./voice-diagnostics";

const m = vi.hoisted(() => ({ actor: vi.fn(), environment: { value: "test" }, info: vi.spyOn(console, "info").mockImplementation(() => undefined) }));
vi.mock("./auth", () => ({ requireMobileActor: m.actor, mobileEnvironment: () => m.environment.value }));
const lease = "3f2a9c1b-0000-4000-8000-000000000001";
const event = (id: number, name = "push.refused", fields: Record<string, unknown> = { reason: "voice_disabled", reported: "1", enabled: "false" }) =>
  ({ id, at: Date.UTC(2026, 9, 30, 8, 0, id % 60), event: name, fields });
const body = (events: unknown[] = [event(1)], extra: Record<string, unknown> = {}) => ({ deviceSession: lease, build: "27", events, ...extra });
const post = (value: unknown = body()) => new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/diagnostics/voice",
  { method: "POST", headers: { "content-type": "application/json" }, body: typeof value === "string" ? value : JSON.stringify(value) });
const logged = () => JSON.parse(m.info.mock.calls.at(-1)![0] as string);
// The rate limit is per profile and per instance: each test signs in its own operator.
let profile = "p", profiles = 0;
const signIn = (id: string) => m.actor.mockResolvedValue({ userId: "u", profileId: id, organizationId: "o", displayName: "D", role: "dispatcher" });
beforeEach(() => {
  m.actor.mockReset(); m.info.mockClear(); m.environment.value = "test";
  profile = "p" + ++profiles; signIn(profile);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("mobile voice diagnostics route", () => {
  it("requires a signed-in operator before reading the batch", async () => {
    m.actor.mockRejectedValue(new MutationError("denied", 401));
    expect((await upload(post("{"))).status).toBe(401); expect(m.info).not.toHaveBeenCalled();
  });
  it("writes one structured log line per batch, with a short device session and no database", async () => {
    const response = await upload(post(body([event(1), event(2, "js.offer.done", { outcome: "not_ready", call: "3f2a9c1b" })])));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ ok: true, profileId: profile, received: 2 });
    expect(m.info).toHaveBeenCalledOnce();
    expect(logged()).toEqual({ scope: "mobile-voice-diag", profile, deviceSession: "3f2a9c1b", build: "27", events: [
      { id: 1, at: "2026-10-30T08:00:01.000Z", event: "push.refused", fields: { reason: "voice_disabled", reported: "1", enabled: "false" } },
      { id: 2, at: "2026-10-30T08:00:02.000Z", event: "js.offer.done", fields: { outcome: "not_ready", call: "3f2a9c1b" } }] });
  });
  it("keeps only known events and keys and redacts phone-number-like values", async () => {
    const response = await upload(post(body([
      event(1, "push.received", { keys: "call_id,caller_name", number: "0900000999", reason: "+421 900", alert: "421-900-000-999", call: "a1b2c3d4", state: 5, type: "" }),
      event(2, "js.unknown"), event(3, "push.refused; drop"), { id: -1, at: 0, event: "emit", fields: {} }, { id: 4, at: 0, event: "emit", fields: [] }, "x"])));
    expect(response.status).toBe(200);
    expect(logged()).toMatchObject({ dropped: 5, events: [{ id: 1, event: "push.received" }] });
    expect(logged().events).toHaveLength(1);
    expect(logged().events[0].fields).toEqual({ keys: "call_id,caller_name", alert: "redacted", call: "a1b2c3d4" });
    expect(JSON.stringify(logged())).not.toMatch(/0900000999|\+421|421-900/);
  });
  it("lets an ID key carry only an 8-hex app ID or a flag and drops long values", async () => {
    const apnsToken = "0123456789abcdef".repeat(4);
    await upload(post(body([event(1, "push.received", { call: "3F2A9C1B", token: apnsToken, push_token: "true", control: "v3:Q2FsbENvbnRyb2xJZA",
      session: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln", user: "novak", client: "3f2a9c1b-0000", has_call_id: "false", state: "x".repeat(65),
      reason: "y".repeat(64), keys: ["call_id", "caller_number", "z".repeat(40)].join(","), payload_keys: "aps," + "w".repeat(41) })])));
    expect(logged().events[0].fields).toEqual({ call: "3f2a9c1b", push_token: "true", has_call_id: "false", reason: "y".repeat(64),
      keys: "call_id,caller_number," + "z".repeat(40) });
    expect(JSON.stringify(logged())).not.toMatch(/0123456789abcdef0123|v3:|eyJ|novak/);
  });
  it("counts every digit of a value, whatever separates them", async () => {
    await upload(post(body([event(1, "push.refused", { reason: "0900--000--999", source: "421..900..000..999", alert: "0900a000b999", code: "fail:409", error: "domain:123456" })])));
    expect(logged().events[0].fields).toEqual({ reason: "redacted", source: "redacted", alert: "redacted", code: "fail:409", error: "domain:123456" });
  });
  it("limits each operator to 10 batches a minute on this instance", async () => {
    for (let index = 0; index < 10; index += 1) expect((await upload(post())).status).toBe(200);
    const limited = await upload(post());
    expect(limited.status).toBe(429); expect(await limited.json()).toMatchObject({ code: "voice_diagnostics_rate_limited" });
    expect(m.info).toHaveBeenCalledTimes(10);
    signIn(profile + "-other"); expect((await upload(post())).status).toBe(200);
    const start = 1_000_000;
    for (let index = 0; index < 10; index += 1) expect(takeVoiceDiagnosticsToken("bucket", start)).toBe(true);
    expect(takeVoiceDiagnosticsToken("bucket", start + 5_000)).toBe(false);
    expect(takeVoiceDiagnosticsToken("bucket", start + 6_000)).toBe(true);
    expect(takeVoiceDiagnosticsToken("bucket", start + 6_001)).toBe(false);
  });
  it("refuses an oversized, empty or malformed batch without logging it", async () => {
    for (const value of [body(Array.from({ length: 101 }, (_, index) => event(index))), body([]), body([event(1)], { name: "Ján" }),
      body([event(1)], { deviceSession: "+421900000999" }), body([event(1)], { build: "27 (Ján)" }), { events: "x" }, "x".repeat(70_000)]) {
      expect((await upload(post(value))).status).toBe(400);
    }
    expect(m.info).not.toHaveBeenCalled();
    expect((await upload(post(body(Array.from({ length: 100 }, (_, index) => event(index)))))).status).toBe(200);
  });
  it("is off in production unless the project enables it", async () => {
    m.environment.value = "production";
    const off = await upload(post());
    expect(off.status).toBe(403); expect(await off.json()).toMatchObject({ code: "voice_diagnostics_disabled" }); expect(m.info).not.toHaveBeenCalled();
    vi.stubEnv("MOBILE_VOICE_DIAGNOSTICS_ENABLED", "true");
    expect((await upload(post())).status).toBe(200); expect(m.info).toHaveBeenCalledOnce();
  });
  it("knows every event and field the app logs", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    // Each call's argument text up to its closing parenthesis.
    const calls = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map(match => {
      let depth = 1, index = match.index! + match[0].length;
      for (; depth && index < text.length; index += 1) depth += "([{".includes(text[index]) ? 1 : ")]}".includes(text[index]) ? -1 : 0;
      return { name: match[1], args: text.slice(match.index! + match[0].length, index) };
    });
    const swift = readFileSync(path.join(root, "mobile/modules/linka-voice/ios/LinkaPhone.swift"), "utf8");
    const holdFlags = swift.slice(swift.indexOf("private func holdFlags"), swift.indexOf("\n  }\n", swift.indexOf("private func holdFlags")));
    const native = calls(swift, /diag\("([a-z_.]+)"/g);
    const script = ["mobile/src/voice/phone.ts", "mobile/src/voice/use-phone.ts"].flatMap(file =>
      calls(readFileSync(path.join(root, file), "utf8"), /(?:this\.diag|debug\?\.)\("([a-z_.]+)"/g));
    const events = [...native.map(call => call.name), ...script.map(call => "js." + call.name)];
    const keys = [...[...native.map(call => call.args), holdFlags].flatMap(text => [...text.matchAll(/"([a-z_]+)":/g)].map(match => match[1])),
      ...script.flatMap(({ args }) => {
        const fields = args.includes("{") ? "{" + args.slice(args.indexOf("{") + 1) : "";
        return [...fields.matchAll(/\b([a-z_]+)\s*:(?!:)/g), ...fields.matchAll(/[{,]\s*([a-z_]+)\s*(?=[,}])/g)].map(match => match[1])
          .concat(fields.includes("...failure(") ? ["status", "code"] : []);
      })];
    expect(events.length).toBeGreaterThan(70); expect(keys.length).toBeGreaterThan(100);
    expect(events.filter(name => !VOICE_DIAGNOSTIC_EVENTS.has(name))).toEqual([]);
    expect([...new Set(keys)].filter(key => !VOICE_DIAGNOSTIC_KEYS.has(key))).toEqual([]);
  });
});
