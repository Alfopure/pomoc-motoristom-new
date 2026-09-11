import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: state.createClient }));
vi.mock("./env", () => ({ requireSupabaseServiceEnv: () => ({ url: "https://isolated.example.test", serviceKey: "synthetic" }) }));
import { createSupabaseAdminClient } from "./admin";
import { telephonyDatabaseFetch } from "@/server/telephony/ownership";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("uses the ownership-aware transport without adding an unrequested read deadline", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("ok"));
  vi.stubGlobal("fetch", fetch);
  createSupabaseAdminClient();
  expect(state.createClient.mock.calls[0][2]).toEqual({ global: { fetch: telephonyDatabaseFetch }, auth: { autoRefreshToken: false, persistSession: false } });
  await telephonyDatabaseFetch("https://isolated.example.test/rest/v1/cases", { method: "PATCH", body: "{}" });
  expect(fetch.mock.calls[0][1].signal).toBeUndefined();
});

it.each(["read", "request"] as const)("composes the %s cancellation without losing request options", async (owner) => {
  const read = new AbortController();
  const request = new AbortController();
  const fetch = vi.fn().mockResolvedValue(new Response("ok"));
  vi.stubGlobal("fetch", fetch);
  createSupabaseAdminClient(read.signal);
  const transport = state.createClient.mock.calls[0][2].global.fetch as typeof globalThis.fetch;
  await transport("https://isolated.example.test/rest/v1/cases", {
    method: "GET", headers: { "x-fixture": "safe" }, signal: request.signal,
  });
  const sent = fetch.mock.calls[0][1] as RequestInit;
  expect(sent.method).toBe("GET");
  expect(new Headers(sent.headers).get("x-fixture")).toBe("safe");
  expect(new Headers(sent.headers).get("x-telephony-writer")).toBe("2");
  expect(sent.signal?.aborted).toBe(false);
  (owner === "read" ? read : request).abort();
  expect(sent.signal?.aborted).toBe(true);
});
