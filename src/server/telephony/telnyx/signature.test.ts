import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createTelnyxPublicKey,
  TELNYX_SIGNATURE_HEADER,
  TELNYX_TIMESTAMP_HEADER,
  telnyxSignedMessage,
  verifyTelnyxRequest,
  verifyTelnyxSignature,
} from "./signature";

const SPKI_PREFIX_LENGTH = 12;

function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  // The Mission Control portal shows base64 of the raw 32-byte key, not SPKI.
  const portalKey = spki.subarray(SPKI_PREFIX_LENGTH).toString("base64");
  return { privateKey, publicKey, portalKey, spkiKey: spki.toString("base64") };
}

function signBody(privateKey: KeyObject, timestamp: string, body: string | Uint8Array) {
  return sign(null, telnyxSignedMessage(timestamp, body), privateKey).toString("base64");
}

const NOW_MS = Date.UTC(2026, 8, 3, 12, 0, 0);
const now = () => NOW_MS;
const timestamp = String(Math.floor(NOW_MS / 1000));
const body = '{"data":{"event_type":"call.initiated","id":"evt-1","payload":{"to":"+4210232408700"}}}';

describe("createTelnyxPublicKey", () => {
  it("accepts the literal portal format (base64 raw 32 bytes)", () => {
    const { portalKey } = makeKeys();
    expect(Buffer.from(portalKey, "base64")).toHaveLength(32);
    expect(createTelnyxPublicKey(portalKey).asymmetricKeyType).toBe("ed25519");
  });

  it("accepts the documented account key shape without throwing", () => {
    // Same length/format as the real portal value; a random key is used so no real key lands in tests.
    const key = createTelnyxPublicKey(makeKeys().portalKey);
    expect(key.type).toBe("public");
  });

  it("accepts SPKI base64 and PEM too", () => {
    const { spkiKey, publicKey } = makeKeys();
    expect(createTelnyxPublicKey(spkiKey).asymmetricKeyType).toBe("ed25519");
    expect(createTelnyxPublicKey(publicKey.export({ format: "pem", type: "spki" }) as string).asymmetricKeyType).toBe("ed25519");
  });

  it("rejects garbage", () => {
    expect(() => createTelnyxPublicKey("")).toThrow();
    expect(() => createTelnyxPublicKey("abc")).toThrow(/raw Ed25519/);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "pem", type: "spki" }) as string;
    expect(() => createTelnyxPublicKey(rsa)).toThrow(/not an Ed25519/);
  });
});

describe("verifyTelnyxSignature", () => {
  it("verifies a valid signature over the raw body", () => {
    const { privateKey, portalKey } = makeKeys();
    const signature = signBody(privateKey, timestamp, body);

    expect(verifyTelnyxSignature({ publicKey: portalKey, signature, timestamp, rawBody: body, now })).toEqual({
      ok: true,
      timestamp: Number(timestamp),
    });
    expect(verifyTelnyxSignature({ publicKey: portalKey, signature, timestamp, rawBody: Buffer.from(body), now })).toMatchObject({ ok: true });
  });

  it("is byte-exact: re-serialised or whitespace-changed bodies fail", () => {
    const { privateKey, portalKey } = makeKeys();
    const signature = signBody(privateKey, timestamp, body);
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);

    expect(verifyTelnyxSignature({ publicKey: portalKey, signature, timestamp, rawBody: reserialised, now })).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
    expect(verifyTelnyxSignature({ publicKey: portalKey, signature, timestamp, rawBody: `${body} `, now })).toMatchObject({ ok: false });
  });

  it("rejects a signature made with another key or over another timestamp", () => {
    const { privateKey, portalKey } = makeKeys();
    const other = makeKeys();
    const signature = signBody(privateKey, timestamp, body);

    expect(verifyTelnyxSignature({ publicKey: other.portalKey, signature, timestamp, rawBody: body, now })).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
    const shifted = String(Number(timestamp) + 1);
    expect(verifyTelnyxSignature({ publicKey: portalKey, signature, timestamp: shifted, rawBody: body, now })).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  });

  it("rejects expired and future timestamps beyond the 300 s tolerance", () => {
    const { privateKey, portalKey } = makeKeys();
    const old = String(Number(timestamp) - 301);
    const future = String(Number(timestamp) + 301);
    const edge = String(Number(timestamp) - 300);

    expect(verifyTelnyxSignature({ publicKey: portalKey, signature: signBody(privateKey, old, body), timestamp: old, rawBody: body, now })).toEqual({
      ok: false,
      reason: "timestamp_out_of_tolerance",
    });
    expect(verifyTelnyxSignature({ publicKey: portalKey, signature: signBody(privateKey, future, body), timestamp: future, rawBody: body, now })).toEqual({
      ok: false,
      reason: "timestamp_out_of_tolerance",
    });
    expect(verifyTelnyxSignature({ publicKey: portalKey, signature: signBody(privateKey, edge, body), timestamp: edge, rawBody: body, now })).toMatchObject({
      ok: true,
    });
  });

  it("reports missing or malformed inputs without throwing", () => {
    const { privateKey, portalKey } = makeKeys();
    const signature = signBody(privateKey, timestamp, body);

    expect(verifyTelnyxSignature({ publicKey: null, signature, timestamp, rawBody: body, now })).toEqual({ ok: false, reason: "missing_public_key" });
    expect(verifyTelnyxSignature({ publicKey: "xx", signature, timestamp, rawBody: body, now })).toEqual({ ok: false, reason: "invalid_public_key" });
    expect(verifyTelnyxSignature({ publicKey: portalKey, signature: null, timestamp, rawBody: body, now })).toEqual({ ok: false, reason: "missing_signature" });
    expect(verifyTelnyxSignature({ publicKey: portalKey, signature, timestamp: "", rawBody: body, now })).toEqual({ ok: false, reason: "missing_timestamp" });
    expect(verifyTelnyxSignature({ publicKey: portalKey, signature, timestamp: "yesterday", rawBody: body, now })).toEqual({ ok: false, reason: "invalid_timestamp" });
    expect(verifyTelnyxSignature({ publicKey: portalKey, signature: "bm90LWEtc2ln", timestamp, rawBody: body, now })).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("reads the Telnyx headers from a Headers object", () => {
    const { privateKey, portalKey } = makeKeys();
    const headers = new Headers({ [TELNYX_SIGNATURE_HEADER]: signBody(privateKey, timestamp, body), [TELNYX_TIMESTAMP_HEADER]: timestamp });

    expect(verifyTelnyxRequest(headers, body, { publicKey: portalKey, now })).toMatchObject({ ok: true });
    expect(verifyTelnyxRequest(new Headers(), body, { publicKey: portalKey, now })).toEqual({ ok: false, reason: "missing_signature" });
  });
});
