import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ permit: vi.fn(), cookie: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.cookie }) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("@/server/diagnostics/canary-access", () => ({ BROWSER_CANARY_COOKIE: "pm-diagnostic-canary", validCanaryPermit: mocks.permit }));
import DiagnosticCanaryPage from "./page";

describe("temporary browser canary page", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("does not render without a valid fixed-purpose permit", async () => {
    mocks.cookie.mockReturnValue(undefined);
    mocks.permit.mockReturnValue(false);
    await expect(DiagnosticCanaryPage()).rejects.toThrow("NOT_FOUND");
    expect(mocks.permit).toHaveBeenCalledWith(undefined);
  });

  it("checks the dedicated permit before rendering the compiled canary", async () => {
    mocks.cookie.mockReturnValue({ value: "signed-permit" });
    mocks.permit.mockReturnValue(true);
    const page = await DiagnosticCanaryPage();
    expect(page.type).toBe("main");
    expect(mocks.cookie).toHaveBeenCalledWith("pm-diagnostic-canary");
    expect(mocks.permit).toHaveBeenCalledWith("signed-permit");
  });
});
