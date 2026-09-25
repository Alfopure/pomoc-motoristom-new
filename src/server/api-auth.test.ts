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

import { requireMotoristActor } from "./api-auth";

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
