import { describe, expect, it } from "vitest";
import { customerCallNumber } from "./number";

describe("customer number from a call", () => {
  it.each([
    ["inbound", "+421 905 123 456", "+421905123456"],
    ["outbound", "00420 777 123 456", "+420777123456"],
    ["inbound", "0905/123-456", "0905123456"],
    ["outbound", "+43 1234567", "+431234567"],
    ["internal", "+421905123456", null],
    ["internal", "1001", null],
    ["inbound", "1001", null],
    ["outbound", "+1001", null],
    ["inbound", "anonymous", null],
    ["inbound", "sip:0905123456@example.test", null],
    ["inbound", "+00421905123456", null],
    ["inbound", "000000000", null],
    ["inbound", "+421905123456789012", null],
    ["unknown", "+421905123456", null],
    ["inbound", null, null],
  ])("%s %s -> %s", (direction, number, expected) => expect(customerCallNumber(direction, number)).toBe(expected));
});
