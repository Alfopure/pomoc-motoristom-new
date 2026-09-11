import { describe, expect, it, vi } from "vitest";
import { createTelnyxRequestLogger } from "./request-telemetry";

const commandId = "bb824028-87c9-442f-bfac-ac527f733493";
const request = { method: "POST", path: "/calls/private-call-token/actions/bridge", commandId, status: 200, ms: 128, retried: false, error: null };

describe("provider HTTP telemetry", () => {
  it.each([
    ["/calls/private-call-token/actions/bridge?token=API_KEY", "/calls/:id/actions/bridge"],
    ["/calls/private%2Fcall%2Btoken", "/calls/:id"],
    ["/conferences/private-conference/participants?filter=+421905123456", "/conferences/:id/participants"],
    ["/conferences/private-conference/actions/join", "/conferences/:id/actions/join"],
    ["/telephony_credentials/private-credential/token", "/telephony_credentials/:id/token"],
    ["/telephony_credentials/private-credential", "/telephony_credentials/:id"],
    ["/phone_numbers?filter=+421905123456", "/phone_numbers"],
    ["/messages/private-message", "/messages/:id"],
    ["/calls/private-token/actions/API_KEY", "/calls/:id/actions/:action"],
    ["/private-token/API_KEY", "/other"],
  ])("redacts identifiers and query values from %s", (path, expected) => {
    const logger = vi.fn();
    createTelnyxRequestLogger(logger)({ ...request, path });
    expect(logger).toHaveBeenCalledExactlyOnceWith({ scope: "telnyx-http", level: "info", method: "POST", path: expected,
      commandId, status: 200, ms: 128, retried: false, errorCode: null });
  });

  it.each([
    ["TelnyxCommandError: Telnyx 90018 (422): +421905123456 API_KEY private-token", "90018"],
    ["TelnyxCommandError: Telnyx timeout (504): https://API_KEY@host/private-token", "timeout"],
    ["TelnyxCommandError: Telnyx network (502): API_KEY", "network"],
    ["TelnyxCommandError: Telnyx http_503 (503): API_KEY", "http_503"],
    ["TelnyxCommandError: Telnyx PRIVATE_API_KEY (500): +421905123456", "provider_error"],
    ["Error: API_KEY private-token +421905123456", "provider_error"],
  ])("emits only a safe error code for %s", (error, code) => {
    const logger = vi.fn();
    createTelnyxRequestLogger(logger)({ ...request, error, commandId: "API_KEY", status: 502, retried: true });
    expect(logger).toHaveBeenCalledExactlyOnceWith({ scope: "telnyx-http", level: "warn", method: "POST", path: "/calls/:id/actions/bridge",
      commandId: null, status: 502, ms: 128, retried: true, errorCode: code });
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(/API_KEY|private-token|421905123456/);
  });

  it("isolates thrown and rejected log-sink failures", async () => {
    const throwing = vi.fn(() => { throw new Error("log sink unavailable"); });
    const rejecting = vi.fn(async () => { throw new Error("async log sink unavailable"); });
    expect(() => createTelnyxRequestLogger(throwing)(request)).not.toThrow();
    expect(() => createTelnyxRequestLogger(rejecting)(request)).not.toThrow();
    await Promise.resolve();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(rejecting).toHaveBeenCalledTimes(1);
  });
});
