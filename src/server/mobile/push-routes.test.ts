import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as register } from "@/app/api/mobile/v1/push/register/route";
import { POST as unregister } from "@/app/api/mobile/v1/push/unregister/route";
import { MutationError } from "@/server/mutation-error";
import { createFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), admin: null as unknown }));
vi.mock("./auth", () => ({ requireMobileActor: mocks.actor, mobileEnvironment: () => "test" }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => mocks.admin }));

const actor = { userId: "user", profileId: "00000000-0000-4000-8000-000000000001", organizationId: "00000000-0000-4000-8000-0000000000a1", displayName: "Operátor", role: "dispatcher" };
const PHONE = "00000000-0000-4000-8000-0000000000f1";
const post = (path: string, body: unknown) => new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/push/" + path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
let fake: FakeSupabase;

beforeEach(() => {
  fake = createFakeSupabase({ uniqueKeys: { motorist_mobile_push_devices: [["id"], ["environment", "installation_id"], ["expo_push_token"]] } });
  mocks.admin = fake.admin;
  mocks.actor.mockReset().mockResolvedValue(actor);
  vi.stubEnv("MOBILE_PUSH_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("mobile push routes", () => {
  it.each([[register, "register"], [unregister, "unregister"]] as const)("denies %s before touching any device", async (route, path) => {
    mocks.actor.mockRejectedValue(new MutationError("denied", 401));
    const response = await route(post(path, { installationId: PHONE }));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(fake.db.log).toEqual([]);
  });

  it("registers this phone and answers with the switches, never the token", async () => {
    const response = await register(post("register", { installationId: PHONE, token: "ExponentPushToken[abcdefghijkl]", platform: "ios", appVersion: "1.0.0" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, apiVersion: 1, environment: "test", profileId: actor.profileId, preferences: { tasks: true, task_due: true, callbacks_mine: true, callbacks_unclaimed: true, cases: true } });
    expect(JSON.stringify(body)).not.toContain("ExponentPushToken");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("tells the app that push is not ready in this environment", async () => {
    vi.stubEnv("MOBILE_PUSH_ENABLED", "");
    const response = await register(post("register", { installationId: PHONE, token: "ExponentPushToken[abcdefghijkl]", platform: "ios" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, code: "push_unavailable" });
  });

  it("refuses a malformed request", async () => {
    expect((await register(post("register", { installationId: PHONE, token: "nope", platform: "ios" }))).status).toBe(400);
    expect((await unregister(post("unregister", { installationId: "phone" }))).status).toBe(400);
  });

  it("unregisters the phone at logout, also where push is switched off", async () => {
    vi.stubEnv("MOBILE_PUSH_ENABLED", "");
    const response = await unregister(post("unregister", { installationId: PHONE }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, removed: false });
  });
});
