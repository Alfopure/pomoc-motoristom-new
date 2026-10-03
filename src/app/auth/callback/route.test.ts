import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ verifyOtp: vi.fn(), exchangeCodeForSession: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth }) }));

import { GET } from "./route";

const origin = "https://dispatch.example";

function request(next?: string, params: Record<string, string> = {}) {
  const url = new URL("/auth/callback", origin);
  if (next !== undefined) url.searchParams.set("next", next);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url);
}

describe("auth callback destinations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.verifyOtp.mockResolvedValue({ error: null });
    auth.exchangeCodeForSession.mockResolvedValue({ error: null });
  });

  it.each([
    undefined, "", "https://outside.invalid", "//outside.invalid", "/\\outside.invalid",
    "/a/..//outside.invalid", "/%2e%2e//outside.invalid", "/\n/outside.invalid",
    "javascript:alert(1)",
  ])("falls back to the same-origin root for %j", async (next) => {
    const response = await GET(request(next));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${origin}/`);
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it.each(["/", "/auth/set-password", "/?view=calls#active", "/cases/a/../b?tab=history"])(
    "preserves the internal destination %s", async (next) => {
      const response = await GET(request(next));
      expect(response.headers.get("location")).toBe(new URL(next, origin).href);
    },
  );

  it("keeps password-recovery OTP verification before redirecting", async () => {
    const response = await GET(request("/auth/set-password", { token_hash: "fixture-hash", type: "recovery" }));
    expect(auth.verifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: "fixture-hash" });
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(`${origin}/auth/set-password`);
  });

  it("keeps the code exchange and same-origin URL for a signed-in return", async () => {
    const response = await GET(request("/?view=calls", { code: "fixture-code" }));
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("fixture-code");
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(`${origin}/?view=calls`);
  });
});
