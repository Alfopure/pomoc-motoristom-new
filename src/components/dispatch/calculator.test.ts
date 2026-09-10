import { describe, expect, it } from "vitest";
import { calculateExpression } from "./calculator";

describe("manual calculator", () => {
  it.each([["140 × 0,75", 105], ["(70 − 50) × 2 × 0,75", 30], ["2+3*4", 14], ["-(2+3)/.5", -10], ["0.1 + 0.2", .3], ["10 / -2", -5], ["1,5 + 1.5", 3]])("calculates %s", (expression, value) => expect(calculateExpression(expression)).toBe(value));
  it.each(["1/0", "2÷(3-3)", "globalThis.alert(1)", "1;2", "Math.random()", "2**3", "1 2", "(2+3", "2(3)", "", "1..2", "1e999"])("rejects invalid or executable input %s", expression => expect(() => calculateExpression(expression)).toThrow());
  it("bounds input and nesting", () => {
    expect(() => calculateExpression("1".repeat(301))).toThrow();
    expect(() => calculateExpression("(".repeat(41) + "1" + ")".repeat(41))).toThrow();
  });
});
