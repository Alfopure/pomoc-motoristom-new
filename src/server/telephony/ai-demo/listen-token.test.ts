import { describe, expect, it } from "vitest";

import { mintListenToken, verifyListenToken } from "./listen-token";

const SECRET = "whsec_c2VjcmV0LWtleQ==";
const ATTEMPT = "3f2b8c1a-5d4e-4a6b-8c9d-0e1f2a3b4c5d";
const OTHER = "11111111-2222-4333-8444-555555555555";

describe("the listen token", () => {
  it("lets the webhook hand this one call to the listener", () => {
    expect(verifyListenToken(SECRET, ATTEMPT, mintListenToken(SECRET, ATTEMPT))).toBe(true);
  });

  it("grants listening to that call and nothing else", () => {
    // Holding a token must not let anybody attach to a different demo.
    expect(verifyListenToken(SECRET, OTHER, mintListenToken(SECRET, ATTEMPT))).toBe(false);
  });

  it("is refused under a different secret", () => {
    expect(verifyListenToken("whsec_b3RoZXI=", ATTEMPT, mintListenToken(SECRET, ATTEMPT))).toBe(false);
  });

  it("expires, so a captured token is not a standing invitation", () => {
    const now = Date.now();
    const token = mintListenToken(SECRET, ATTEMPT, now);
    expect(verifyListenToken(SECRET, ATTEMPT, token, now + 25 * 60_000)).toBe(false);
  });

  it("accepts the previous window, so a call starting on a boundary still works", () => {
    const now = Date.now();
    const token = mintListenToken(SECRET, ATTEMPT, now);
    expect(verifyListenToken(SECRET, ATTEMPT, token, now + 10 * 60_000)).toBe(true);
  });

  it("refuses anything that is not a token", () => {
    for (const value of ["", "nonsense", "0.", ".abc", "abc.def"]) {
      expect(verifyListenToken(SECRET, ATTEMPT, value), value).toBe(false);
    }
  });
});
