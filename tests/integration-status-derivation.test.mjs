import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/data/integration-status.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const moduleUnderTest = { exports: {} };

vm.runInNewContext(compiled, {
  exports: moduleUnderTest.exports,
  module: moduleUnderTest,
});

const { deriveEffectiveIntegrationStatus } = moduleUnderTest.exports;

test("not_configured + secretConfigured → configured (telephony env creds present)", () => {
  assert.equal(deriveEffectiveIntegrationStatus("not_configured", true), "configured");
});

test("not_configured + !secretConfigured → not_configured (no creds, stays red)", () => {
  assert.equal(deriveEffectiveIntegrationStatus("not_configured", false), "not_configured");
});

test("live stays live regardless of secretConfigured (writer value wins)", () => {
  assert.equal(deriveEffectiveIntegrationStatus("live", true), "live");
});

test("degraded is left untouched", () => {
  assert.equal(deriveEffectiveIntegrationStatus("degraded", true), "degraded");
});
