import { createPublicKey, verify as verifyEd25519, type KeyObject } from "node:crypto";

/**
 * Telnyx webhook signatures.
 *
 * Every webhook carries `telnyx-signature-ed25519` (base64) and
 * `telnyx-timestamp` (unix seconds). The signed message is
 * `${timestamp}|${rawBody}` and must be verified over the **raw** request
 * bytes, never re-serialised JSON. The public key shown in Mission Control is
 * the base64 of the raw 32-byte Ed25519 key; Node needs it wrapped in a SPKI
 * DER envelope, which is a constant 12-byte prefix.
 */

export const TELNYX_SIGNATURE_HEADER = "telnyx-signature-ed25519";
export const TELNYX_TIMESTAMP_HEADER = "telnyx-timestamp";
export const TELNYX_SIGNATURE_TOLERANCE_SECONDS = 300;

/** DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_RAW_KEY_LENGTH = 32;
const ED25519_SIGNATURE_LENGTH = 64;

export type TelnyxSignatureFailure =
  | "missing_public_key"
  | "invalid_public_key"
  | "missing_signature"
  | "missing_timestamp"
  | "invalid_timestamp"
  | "timestamp_out_of_tolerance"
  | "invalid_signature";

export type TelnyxSignatureResult = { ok: true; timestamp: number } | { ok: false; reason: TelnyxSignatureFailure };

export type VerifyTelnyxSignatureInput = {
  /** Portal-format key (base64 raw 32 bytes); a base64 SPKI DER or PEM is accepted too. */
  publicKey: string | null | undefined;
  signature: string | null | undefined;
  timestamp: string | null | undefined;
  rawBody: string | Uint8Array;
  toleranceSeconds?: number;
  /** Clock in milliseconds since the epoch; injectable for tests. */
  now?: () => number;
};

const keyCache = new Map<string, KeyObject>();

/** Builds a KeyObject from the portal key. Throws on malformed input. */
export function createTelnyxPublicKey(publicKey: string): KeyObject {
  const trimmed = publicKey.trim();
  if (!trimmed) throw new Error("Telnyx public key is empty");

  const cached = keyCache.get(trimmed);
  if (cached) return cached;

  let key: KeyObject;
  if (trimmed.startsWith("-----BEGIN")) {
    key = createPublicKey({ key: trimmed, format: "pem" });
  } else {
    const bytes = Buffer.from(trimmed, "base64");
    if (bytes.length === ED25519_RAW_KEY_LENGTH) {
      key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]), format: "der", type: "spki" });
    } else if (bytes.length === ED25519_SPKI_PREFIX.length + ED25519_RAW_KEY_LENGTH && bytes.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
      key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    } else {
      throw new Error("Telnyx public key must be a base64 raw Ed25519 key");
    }
  }

  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Telnyx public key is not an Ed25519 key");
  }
  keyCache.set(trimmed, key);
  return key;
}

function parseTimestamp(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,12}$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Signed-message bytes exactly as Telnyx computes them. */
export function telnyxSignedMessage(timestamp: string, rawBody: string | Uint8Array): Buffer {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  return Buffer.concat([Buffer.from(`${timestamp}|`, "utf8"), body]);
}

export function verifyTelnyxSignature(input: VerifyTelnyxSignatureInput): TelnyxSignatureResult {
  if (!input.publicKey || !input.publicKey.trim()) return { ok: false, reason: "missing_public_key" };

  let key: KeyObject;
  try {
    key = createTelnyxPublicKey(input.publicKey);
  } catch {
    return { ok: false, reason: "invalid_public_key" };
  }

  const signatureHeader = input.signature?.trim();
  if (!signatureHeader) return { ok: false, reason: "missing_signature" };
  const timestampHeader = input.timestamp?.trim();
  if (!timestampHeader) return { ok: false, reason: "missing_timestamp" };

  const timestamp = parseTimestamp(timestampHeader);
  if (timestamp === null) return { ok: false, reason: "invalid_timestamp" };

  const tolerance = input.toleranceSeconds ?? TELNYX_SIGNATURE_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((input.now ?? Date.now)() / 1000);
  if (Math.abs(nowSeconds - timestamp) > tolerance) return { ok: false, reason: "timestamp_out_of_tolerance" };

  const signature = Buffer.from(signatureHeader, "base64");
  if (signature.length !== ED25519_SIGNATURE_LENGTH) return { ok: false, reason: "invalid_signature" };

  let valid = false;
  try {
    valid = verifyEd25519(null, telnyxSignedMessage(timestampHeader, input.rawBody), key, signature);
  } catch {
    valid = false;
  }

  return valid ? { ok: true, timestamp } : { ok: false, reason: "invalid_signature" };
}

/** Convenience for route handlers: reads the two headers from a `Headers` object. */
export function verifyTelnyxRequest(
  headers: Pick<Headers, "get">,
  rawBody: string | Uint8Array,
  options: Omit<VerifyTelnyxSignatureInput, "signature" | "timestamp" | "rawBody">,
): TelnyxSignatureResult {
  return verifyTelnyxSignature({
    ...options,
    signature: headers.get(TELNYX_SIGNATURE_HEADER),
    timestamp: headers.get(TELNYX_TIMESTAMP_HEADER),
    rawBody,
  });
}
