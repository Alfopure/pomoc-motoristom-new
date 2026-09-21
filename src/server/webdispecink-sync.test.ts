import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdmin: vi.fn(),
  resolveOrganization: vi.fn(),
  getConfig: vi.fn(),
  createProvider: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.createAdmin }));
vi.mock("@/server/default-organization", () => ({ resolveDefaultOrganizationId: mocks.resolveOrganization }));
vi.mock("@/lib/integrations/webdispecink/client", () => ({
  getWebdispecinkConfig: mocks.getConfig,
  createWebdispecinkClient: mocks.createProvider,
  serializeWebdispecinkError: vi.fn(),
}));

import { syncWebdispecinkFleet } from "./webdispecink-sync";

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());

it.each(["false", "off", "0", "disabled", " FALSE "])(
  "blocks service-level fleet refresh for %s before database or provider access",
  async (flag) => {
    vi.stubEnv("WEBDISPECINK_SYNC_ENABLED", flag);

    await expect(syncWebdispecinkFleet({ mode: "full" })).rejects.toMatchObject({
      status: 503,
      message: "WebDispečink sync je vypnutý cez WEBDISPECINK_SYNC_ENABLED.",
    });

    expect(mocks.getConfig).not.toHaveBeenCalled();
    expect(mocks.createAdmin).not.toHaveBeenCalled();
    expect(mocks.resolveOrganization).not.toHaveBeenCalled();
    expect(mocks.createProvider).not.toHaveBeenCalled();
  },
);

it.each([undefined, "true"])(
  "validates credentials before database access when the sync flag is %s",
  async (flag) => {
    vi.stubEnv("WEBDISPECINK_SYNC_ENABLED", flag);
    const missingCredentials = new Error("WebDispecink API credentials are not configured.");
    mocks.getConfig.mockImplementation(() => { throw missingCredentials; });

    await expect(syncWebdispecinkFleet()).rejects.toBe(missingCredentials);

    expect(mocks.getConfig).toHaveBeenCalledOnce();
    expect(mocks.createAdmin).not.toHaveBeenCalled();
    expect(mocks.resolveOrganization).not.toHaveBeenCalled();
    expect(mocks.createProvider).not.toHaveBeenCalled();
  },
);
