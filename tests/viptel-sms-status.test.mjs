import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/lib/integrations/viptel/sms-status.ts", import.meta.url), "utf8");
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
  { filename: "src/lib/integrations/viptel/sms-status.ts" },
);

const { mapViptelSmsStatusCode } = moduleUnderTest.exports;

test("maps VIPTel SMS gateway acceptance separately from delivery", () => {
  assert.deepEqual(asPlainObject(mapViptelSmsStatusCode(201)), {
    providerStatusCode: 201,
    status: "sent",
    statusDetail: "accepted_by_gateway",
    terminal: false,
  });
});

test("maps VIPTel SMS delivery statuses", () => {
  assert.deepEqual(asPlainObject(mapViptelSmsStatusCode("203")), {
    providerStatusCode: 203,
    status: "sent",
    statusDetail: "sent_to_provider",
    terminal: false,
  });
  assert.deepEqual(asPlainObject(mapViptelSmsStatusCode(200)), {
    providerStatusCode: 200,
    status: "delivered",
    statusDetail: "delivered",
    terminal: true,
  });
});

test("maps VIPTel SMS failure statuses", () => {
  assert.equal(mapViptelSmsStatusCode(207).statusDetail, "undelivered");
  assert.equal(mapViptelSmsStatusCode(403).statusDetail, "forbidden_destination");
  assert.equal(mapViptelSmsStatusCode(408).statusDetail, "expired");
  assert.equal(mapViptelSmsStatusCode(503).statusDetail, "provider_unavailable");

  for (const code of [207, 403, 408, 503]) {
    const mapped = mapViptelSmsStatusCode(code);
    assert.equal(mapped.status, "failed");
    assert.equal(mapped.terminal, true);
  }
});

test("keeps unknown VIPTel SMS statuses non-terminal for reconciliation", () => {
  assert.deepEqual(asPlainObject(mapViptelSmsStatusCode("999")), {
    providerStatusCode: 999,
    status: "sent",
    statusDetail: "unknown_provider_status",
    terminal: false,
  });
  assert.deepEqual(asPlainObject(mapViptelSmsStatusCode("not-a-code")), {
    providerStatusCode: null,
    status: "sent",
    statusDetail: "unknown_provider_status",
    terminal: false,
  });
});

function asPlainObject(value) {
  return JSON.parse(JSON.stringify(value));
}
