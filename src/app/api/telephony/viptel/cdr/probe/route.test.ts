import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "./route";

const SECRET = "test-probe-secret";

function probeRequest(token?: string) {
  return new Request("https://example.test/api/telephony/viptel/cdr/probe", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("GET /api/telephony/viptel/cdr/probe", () => {
  beforeEach(() => {
    process.env.RECORDINGS_SYNC_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.RECORDINGS_SYNC_SECRET;
  });

  it("returns 500 when the secret is not configured", async () => {
    delete process.env.RECORDINGS_SYNC_SECRET;
    const response = await GET(probeRequest(SECRET));
    expect(response.status).toBe(500);
  });

  it("returns 401 without a bearer token", async () => {
    const response = await GET(probeRequest());
    expect(response.status).toBe(401);
  });

  it("returns 401 for a wrong token", async () => {
    const response = await GET(probeRequest("wrong"));
    expect(response.status).toBe(401);
  });

  it("fails closed with Hetzner-only guidance for a valid token", async () => {
    const response = await GET(probeRequest(SECRET));
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body).toMatchObject({ ok: false, executionTarget: "hetzner_one_shot" });
  });
});
