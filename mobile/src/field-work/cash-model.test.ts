import { describe, expect, it } from "vitest";
import { canProposeCash, cashAmountCents, cashEuro } from "./cash-model";

describe("actual receipt amount", () => {
  it.each([["0,01", 1], ["19.99", 1999], ["1 234,5", 123450], ["999999999,99", 99999999999]])("parses %s exactly", (value, expected) => expect(cashAmountCents(value as string)).toBe(expected));
  it.each(["", "0", "-10", "0.001", "1e3", "Infinity", "12,34.56", "1000000000", "12,", "abc"])("rejects %s", value => expect(cashAmountCents(value)).toBeNull());
  it("never treats reserved cash or a missing account as available", () => {
    expect(canProposeCash(7000, { balanceCents: 10000, reservedCents: 3000 })).toBe(true);
    expect(canProposeCash(7001, { balanceCents: 10000, reservedCents: 3000 })).toBe(false);
    expect(canProposeCash(1, null)).toBe(false);
    expect(canProposeCash(null, { balanceCents: 100, reservedCents: 0 })).toBe(false);
    expect(cashEuro(null)).toBe("Neurčené");
  });
});
