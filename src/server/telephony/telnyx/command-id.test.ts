import { describe, expect, it } from "vitest";

import { commandId, commandIdName, TELNYX_COMMAND_NAMESPACE, uuidV5 } from "./command-id";

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidV5", () => {
  it("matches the RFC 4122 reference vector", () => {
    // uuid5(NAMESPACE_DNS, "python.org") from the Python standard library docs.
    expect(uuidV5("python.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
  });

  it("rejects a malformed namespace", () => {
    expect(() => uuidV5("x", "not-a-uuid")).toThrow(/namespace/i);
  });
});

describe("commandId", () => {
  const input = { sessionId: "6f1c1c1e-1234-4abc-8def-0123456789ab", legId: "v3:abc", step: 2, intent: "bridge" };

  it("is deterministic and a valid version-5 UUID", () => {
    const first = commandId(input);
    const second = commandId({ ...input });
    expect(first).toBe(second);
    expect(first).toMatch(UUID_V5);
    expect(commandId(input)).toBe(uuidV5(commandIdName(input), TELNYX_COMMAND_NAMESPACE));
  });

  it("changes with every component", () => {
    const base = commandId(input);
    expect(commandId({ ...input, sessionId: "other" })).not.toBe(base);
    expect(commandId({ ...input, legId: "other" })).not.toBe(base);
    expect(commandId({ ...input, step: 3 })).not.toBe(base);
    expect(commandId({ ...input, intent: "hangup" })).not.toBe(base);
    expect(commandId({ ...input, step: "2" })).toBe(base);
  });

  it("refuses empty parts and the separator character", () => {
    expect(() => commandId({ ...input, intent: "" })).toThrow(/intent/);
    expect(() => commandId({ ...input, legId: "a|b" })).toThrow(/legId/);
  });
});
