import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST } from "./route";

const SECRET = "test-sync-secret";

function syncRequest(token?: string, body?: unknown) {
  return new Request("https://example.test/api/telephony/recordings/sync", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/telephony/recordings/sync", () => {
  beforeEach(() => {
    process.env.RECORDINGS_SYNC_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.RECORDINGS_SYNC_SECRET;
  });

  it("returns 500 when the secret is not configured", async () => {
    delete process.env.RECORDINGS_SYNC_SECRET;
    const response = await POST(syncRequest(SECRET));
    expect(response.status).toBe(500);
  });

  it("returns 401 without a bearer token", async () => {
    const response = await POST(syncRequest());
    expect(response.status).toBe(401);
  });

  it("returns 401 for a wrong token", async () => {
    const response = await POST(syncRequest("wrong"));
    expect(response.status).toBe(401);
  });

  it("fails closed with Hetzner-only guidance for an authenticated request", async () => {
    const response = await POST(syncRequest(SECRET, { dryRun: true, dateFrom: "2026-07-01 00:00:00", maxDownloads: 5 }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ executionTarget: "hetzner_one_shot" });
  });
});
