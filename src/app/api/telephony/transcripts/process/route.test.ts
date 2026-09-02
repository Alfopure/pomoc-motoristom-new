import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const processTranscripts = vi.fn();

vi.mock("@/server/telephony/transcripts-process", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/telephony/transcripts-process")>();

  return {
    ...original,
    processTranscripts: (...args: Parameters<typeof original.processTranscripts>) => processTranscripts(...args),
  };
});

import { POST } from "./route";

const SECRET = "test-transcripts-secret";

function processRequest(token?: string, body?: unknown) {
  return new Request("https://example.test/api/telephony/transcripts/process", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/telephony/transcripts/process", () => {
  beforeEach(() => {
    process.env.RECORDINGS_SYNC_SECRET = SECRET;
    processTranscripts.mockReset();
  });

  afterEach(() => {
    delete process.env.RECORDINGS_SYNC_SECRET;
  });

  it("returns 401 without a bearer token", async () => {
    const response = await POST(processRequest());
    expect(response.status).toBe(401);
    expect(processTranscripts).not.toHaveBeenCalled();
  });

  it("runs processing and passes through options", async () => {
    processTranscripts.mockResolvedValue({ status: "ok", processed: 1, failed: 0, errors: [] });
    const response = await POST(processRequest(SECRET, { maxItems: 2, dryRun: true }));
    expect(response.status).toBe(200);
    expect(processTranscripts).toHaveBeenCalledWith({ dryRun: true, maxItems: 2 });
  });

  it("returns 200 for a disabled feature flag summary", async () => {
    processTranscripts.mockResolvedValue({ status: "disabled", processed: 0, failed: 0, errors: [] });
    const response = await POST(processRequest(SECRET));
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("disabled");
  });

  it("maps a failed summary to 502", async () => {
    processTranscripts.mockResolvedValue({ status: "failed", errors: ["boom"] });
    const response = await POST(processRequest(SECRET));
    expect(response.status).toBe(502);
  });
});
