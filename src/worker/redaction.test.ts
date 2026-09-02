import { describe, expect, it } from "vitest";

import { safeErrorMessage } from "./redaction";

describe("worker error redaction", () => {
  it("redacts bearer tokens and phone numbers", () => {
    const message = safeErrorMessage(
      new Error("Authorization: Bearer secret-token password=hunter2 caller +421 900 123 456"),
    );

    expect(message).not.toContain("secret-token");
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("421 900 123 456");
    expect(message).toContain("[REDACTED]");
    expect(message).toContain("[PHONE]");
  });
});
