import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdmin: vi.fn(),
  createServer: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocks.createAdmin,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocks.createServer,
}));

vi.mock("./default-organization", () => ({
  resolveDefaultOrganizationId: vi.fn(async () => "org-1"),
}));

import {
  assertSameOriginRequest, clearProfileCache, getDefaultMotoristAuthState, motoristAccessGuard,
  requireDefaultMotoristActor, requireDefaultMotoristOrgMember, requireDefaultMotoristOrgRole,
  requireMotoristActor, requireMotoristOrgMember,
} from "./api-auth";

describe("development actor resolution", () => {
  beforeEach(() => {
    mocks.createAdmin.mockReset();
    mocks.createServer.mockReset();
    vi.stubEnv("NODE_ENV", "development");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the signed-in employee during npm run dev when bypass is not explicitly enabled", async () => {
    vi.stubEnv("MOTORIST_DEV_AUTH_BYPASS", "");
    mocks.createServer.mockResolvedValue(makeAuthenticatedClient({
      id: "profile-jakub",
      display_name: "Jakub",
      role: "dispatcher",
      email: "jakub@example.test",
    }));

    const actor = await requireMotoristActor("org-1", ["dispatcher"]);

    expect(actor).toMatchObject({
      userId: "user-jakub",
      profileId: "profile-jakub",
      displayName: "Jakub",
    });
    expect(mocks.createAdmin).not.toHaveBeenCalled();
  });

  it("uses a development profile only when bypass is explicitly true", async () => {
    vi.stubEnv("MOTORIST_DEV_AUTH_BYPASS", "true");
    mocks.createAdmin.mockReturnValue(makeDevelopmentClient({
      id: "profile-michal",
      user_id: "user-michal",
      display_name: "Michal Jonas",
      role: "dispatcher",
      email: "michal@example.test",
    }));

    const actor = await requireMotoristActor("org-1", ["dispatcher"]);

    expect(actor).toMatchObject({
      userId: "user-michal",
      profileId: "profile-michal",
      displayName: "Michal Jonas",
    });
    expect(mocks.createServer).not.toHaveBeenCalled();
  });
});

function makeAuthenticatedClient(profile: {
  id: string;
  display_name: string;
  role: "dispatcher";
  email: string;
}) {
  const query = makeQuery({ ...profile });

  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: "user-jakub", email: profile.email } },
        error: null,
      })),
    },
    from: vi.fn(() => query),
  };
}

function makeDevelopmentClient(profile: {
  id: string;
  user_id: string;
  display_name: string;
  role: "dispatcher";
  email: string;
}) {
  return {
    from: vi.fn(() => makeQuery(profile)),
  };
}

function makeQuery<T>(data: T) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    in: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
  };

  return query;
}

describe("signed-in actor resolution", () => {
  beforeEach(async () => {
    mocks.createAdmin.mockReset();
    mocks.createServer.mockReset();
    vi.stubEnv("MOTORIST_DEV_AUTH_BYPASS", "");
    (await import("./api-auth")).clearProfileCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("verifies the token locally and reuses the active profile for the same user", async () => {
    const profile = { id: "profile-jana", display_name: "Jana", role: "dispatcher" as const, email: "jana@example.test" };
    const query = makeQuery(profile);
    const getClaims = vi.fn(async () => ({ data: { claims: { sub: "user-jana", email: "jana@example.test" } }, error: null }));
    const getUser = vi.fn();
    mocks.createServer.mockResolvedValue({ auth: { getClaims, getUser }, from: vi.fn(() => query) });

    const first = await requireMotoristActor("org-1", ["dispatcher"]);
    const second = await requireMotoristActor("org-1", ["dispatcher"]);

    expect(first).toMatchObject({ userId: "user-jana", profileId: "profile-jana" });
    expect(second).toEqual(first);
    expect(getClaims).toHaveBeenCalledTimes(2);
    expect(getUser).not.toHaveBeenCalled();
    expect(query.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it("still rejects an invalid token even when the profile is cached", async () => {
    const profile = { id: "profile-jana", display_name: "Jana", role: "dispatcher" as const, email: "jana@example.test" };
    const query = makeQuery(profile);
    const getClaims = vi.fn()
      .mockResolvedValueOnce({ data: { claims: { sub: "user-jana" } }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "Invalid JWT signature" } });
    mocks.createServer.mockResolvedValue({ auth: { getClaims, getUser: vi.fn() }, from: vi.fn(() => query) });

    await requireMotoristActor("org-1", ["dispatcher"]);
    await expect(requireMotoristActor("org-1", ["dispatcher"])).rejects.toMatchObject({ status: 401 });
  });

  it("re-reads a missing profile instead of caching the refusal", async () => {
    const missing = makeQuery(null);
    const getClaims = vi.fn(async () => ({ data: { claims: { sub: "user-new" } }, error: null }));
    mocks.createServer.mockResolvedValue({ auth: { getClaims, getUser: vi.fn() }, from: vi.fn(() => missing) });

    await expect(requireMotoristActor("org-1")).rejects.toMatchObject({ status: 403 });
    await expect(requireMotoristActor("org-1")).rejects.toMatchObject({ status: 403 });
    expect(missing.maybeSingle).toHaveBeenCalledTimes(2);
  });
});

describe("development bypass deployment boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearProfileCache();
    vi.stubEnv("MOTORIST_DEV_AUTH_BYPASS", "true");
    vi.stubEnv("NODE_ENV", "development");
    for (const key of ["VERCEL", "VERCEL_ENV", "VERCEL_PROJECT_ID", "MOTORIST_APP_ENV"]) vi.stubEnv(key, "");
    mocks.createServer.mockResolvedValue({ auth: { getClaims: async () => ({ data: null, error: null }) } });
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["production runtime", { NODE_ENV: "production" }],
    ["unit-test runtime", { NODE_ENV: "test" }],
    ["missing runtime", { NODE_ENV: "" }],
    ["Vercel marker", { VERCEL: "1" }],
    ["Vercel project identity", { VERCEL_PROJECT_ID: "prj_fixture" }],
    ["Preview claiming development", { VERCEL_ENV: "preview" }],
    ["hosted production", { NODE_ENV: "production", VERCEL_ENV: "production", MOTORIST_APP_ENV: "production" }],
    ["dedicated TEST", { VERCEL_ENV: "production", MOTORIST_APP_ENV: "test" }],
    ["explicit production data environment", { MOTORIST_APP_ENV: "production" }],
    ["explicit TEST data environment", { MOTORIST_APP_ENV: "test" }],
  ] as Array<[string, Record<string, string>]>)("requires authentication and Origin validation in %s", async (_name, env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

    expect((await motoristAccessGuard({ roles: ["admin"] }))?.status).toBe(401);
    await expect(requireDefaultMotoristOrgMember()).rejects.toMatchObject({ status: 401 });
    await expect(requireDefaultMotoristOrgRole(["admin"])).rejects.toMatchObject({ status: 401 });
    await expect(requireMotoristOrgMember("org-1")).rejects.toMatchObject({ status: 401 });
    await expect(requireDefaultMotoristActor()).rejects.toMatchObject({ status: 401 });
    await expect(requireMotoristActor("org-1")).rejects.toMatchObject({ status: 401 });
    await expect(getDefaultMotoristAuthState()).resolves.toMatchObject({ authorized: false, reason: "unauthenticated" });
    expect(() => assertSameOriginRequest(new Request("https://dispatch.example/api/users", {
      method: "POST", headers: { host: "dispatch.example", origin: "https://outside.invalid" },
    }))).toThrow();
    expect(mocks.createAdmin).not.toHaveBeenCalled();
  });

  it("retains the explicit bypass in the local development server", async () => {
    expect(await motoristAccessGuard({ roles: ["admin"] })).toBeNull();
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it("still enforces the signed-in user's role when a hosted flag is misconfigured", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    mocks.createServer.mockResolvedValue(makeAuthenticatedClient({
      id: "profile-dispatcher", display_name: "Fixture", role: "dispatcher", email: "dispatcher@example.test",
    }));
    expect((await motoristAccessGuard({ roles: ["admin"] }))?.status).toBe(403);
    expect(mocks.createAdmin).not.toHaveBeenCalled();
  });
});
