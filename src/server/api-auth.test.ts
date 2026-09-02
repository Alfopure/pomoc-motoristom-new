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
