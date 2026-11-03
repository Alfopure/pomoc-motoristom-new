import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as report } from "@/app/api/mobile/v1/diagnostics/errors/route";
import { MutationError } from "@/server/mutation-error";

const m = vi.hoisted(() => ({ actor: vi.fn(), error: vi.spyOn(console, "error").mockImplementation(() => undefined) }));
vi.mock("./auth", () => ({ requireMobileActor: m.actor, mobileEnvironment: () => "test" }));
const body = { kind: "render", message: "Boom", stack: null, component: "in Shell", version: "1.0.0", build: null, platform: "ios", osVersion: "26.0", preview: true };
const post = (text = JSON.stringify(body)) => new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/diagnostics/errors", { method: "POST", headers: { "content-type": "application/json" }, body: text });
beforeEach(() => { m.actor.mockReset(); m.error.mockClear(); m.actor.mockResolvedValue({ userId: "u", profileId: "p", organizationId: "o", displayName: "D", role: "dispatcher" }); });

describe("mobile error report route", () => {
  it("requires a signed-in operator before reading the report", async () => {
    m.actor.mockRejectedValue(new MutationError("denied", 401));
    expect((await report(post("{"))).status).toBe(401); expect(m.error).not.toHaveBeenCalled();
  });
  it("logs a valid report and refuses a malformed one", async () => {
    const ok = await report(post());
    expect(ok.status).toBe(200); expect(ok.headers.get("cache-control")).toContain("no-store");
    expect(m.error).toHaveBeenCalledOnce();
    expect((await report(post(JSON.stringify({ ...body, kind: "warn" })))).status).toBe(400);
    expect(m.error).toHaveBeenCalledOnce();
  });
});
