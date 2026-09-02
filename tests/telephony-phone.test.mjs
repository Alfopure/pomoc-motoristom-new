import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/lib/telephony/phone.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const moduleUnderTest = { exports: {} };

vm.runInNewContext(
  compiled,
  {
    console,
    exports: moduleUnderTest.exports,
    module: moduleUnderTest,
    require,
  },
  { filename: "src/lib/telephony/phone.ts" },
);

const { formatViptelDialTarget, normalizeDialNumberForComparison, sameDialNumber } = moduleUnderTest.exports;

test("formats Slovak +421 destinations to local 0 prefix for VIPTel", () => {
  assert.equal(formatViptelDialTarget("+421 910 541 622"), "0910541622");
  assert.equal(formatViptelDialTarget("421910541622"), "0910541622");
  assert.equal(formatViptelDialTarget("0910 541 622"), "0910541622");
});

test("formats foreign plus destinations to 00 prefix and preserves existing 00 prefix", () => {
  assert.equal(formatViptelDialTarget("+420 123 456 789"), "00420123456789");
  assert.equal(formatViptelDialTarget("00420 123 456 789"), "00420123456789");
  assert.equal(formatViptelDialTarget("+399 123 456 789"), "00399123456789");
});

test("keeps PBX extensions numeric", () => {
  assert.equal(formatViptelDialTarget("10"), "10");
  assert.equal(formatViptelDialTarget("1234"), "1234");
});

test("rejects malformed call targets", () => {
  assert.throws(() => formatViptelDialTarget(""), /required/);
  assert.throws(() => formatViptelDialTarget("abc"), /valid phone number/);
  assert.throws(() => formatViptelDialTarget("+421<script>"), /valid phone number/);
});

test("normalizes equivalent Slovak numbers for caller matching", () => {
  assert.equal(normalizeDialNumberForComparison("+421 910 541 622"), "421910541622");
  assert.equal(normalizeDialNumberForComparison("0910 541 622"), "421910541622");
  assert.equal(normalizeDialNumberForComparison("00421 910 541 622"), "421910541622");
  assert.equal(sameDialNumber("+421 910 541 622", "0910541622"), true);
  assert.equal(sameDialNumber("+420 123 456 789", "0910541622"), false);
});
