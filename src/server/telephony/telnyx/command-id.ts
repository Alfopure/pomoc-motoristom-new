import { createHash } from "node:crypto";

/**
 * Deterministic Telnyx `command_id`s.
 *
 * Telnyx ignores a repeated command that carries the same `command_id` for the
 * same call, so a webhook that is delivered twice (or a reducer that is re-run
 * after a crash) must produce byte-identical ids. We derive a UUID v5 from
 * `sessionId|legId|step|intent`; the namespace below is fixed for this
 * application and must never change once calls are live.
 */
export const TELNYX_COMMAND_NAMESPACE = "2f1a9a7e-5c4b-4b2e-9d3e-7c1f0e6b8a21";

export type CommandIdInput = {
  /** `motorist_call_sessions.id` (or another stable session key). */
  sessionId: string;
  /** Target leg identifier (`call_control_id`, or a symbolic leg such as "customer"). */
  legId: string;
  /** Ring step index or another monotonic counter; string form is used verbatim. */
  step: number | string;
  /** Intent label such as `answer`, `bridge`, `hangup:losers`. */
  intent: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidToBytes(uuid: string): Buffer {
  if (!UUID_PATTERN.test(uuid)) {
    throw new Error(`Invalid namespace UUID: ${uuid}`);
  }
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** RFC 4122 UUID v5 (SHA-1) of `name` within `namespace`. */
export function uuidV5(name: string, namespace: string = TELNYX_COMMAND_NAMESPACE): string {
  const hash = createHash("sha1").update(uuidToBytes(namespace)).update(Buffer.from(name, "utf8")).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(bytes);
}

/** The canonical name hashed into a command id; exported for logging/tests. */
export function commandIdName(input: CommandIdInput): string {
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || String(value).length === 0) {
      throw new Error(`commandId: "${key}" must not be empty`);
    }
    if (String(value).includes("|")) {
      throw new Error(`commandId: "${key}" must not contain "|"`);
    }
  }
  return `${input.sessionId}|${input.legId}|${String(input.step)}|${input.intent}`;
}

export function commandId(input: CommandIdInput): string {
  return uuidV5(commandIdName(input));
}
