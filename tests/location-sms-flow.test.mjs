import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);

const templates = loadTsModule("../src/lib/sms/templates.ts", "src/lib/sms/templates.ts");
const locationShare = loadTsModule("../src/lib/sms/location-share.ts", "src/lib/sms/location-share.ts", { process });

test("renders location SMS with opaque link placeholder in preview", () => {
  const preview = templates.renderLocationRequestSmsPreview("PM-20260612-0001");

  assert.match(preview, /PM-20260612-0001/);
  assert.match(preview, /\{bezpecny-link\}/);
  assert.doesNotMatch(preview, /\/cases\//);
});

test("renders location SMS with provided secure link", () => {
  const body = templates.renderSmsTemplate("location_request", {
    brandName: "Pomoc motoristom",
    caseNumber: "PM-20260612-0002",
    link: "https://app.example/l/opaque-token",
  });

  assert.match(body, /https:\/\/app\.example\/l\/opaque-token/);
  assert.match(body, /Na tuto SMS neodpovedajte/);
});

test("hashes location link tokens without storing the raw token", () => {
  const first = locationShare.hashLocationShareToken("opaque-token", "pepper-a");
  const second = locationShare.hashLocationShareToken(" opaque-token ", "pepper-a");
  const differentPepper = locationShare.hashLocationShareToken("opaque-token", "pepper-b");

  assert.equal(first, second);
  assert.notEqual(first, differentPepper);
  assert.equal(first.length, 64);
  assert.equal(first.includes("opaque-token"), false);
});

test("validates public GPS payloads", () => {
  assert.deepEqual(asPlainObject(locationShare.validatePublicLocationPayload({
    accuracy: "12.345",
    clientTimestamp: "2026-06-12T10:00:00.000Z",
    lat: "48.14859651",
    lng: "17.10774791",
  })), {
    accuracy: 12.35,
    clientTimestamp: "2026-06-12T10:00:00.000Z",
    lat: 48.1485965,
    lng: 17.1077479,
  });

  assert.throws(() => locationShare.validatePublicLocationPayload({ lat: 91, lng: 17 }), /sirka/);
  assert.throws(() => locationShare.validatePublicLocationPayload({ lat: 48, lng: 181 }), /dlzka/);
});

function loadTsModule(relativePath, filename, extraContext = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
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
      ...extraContext,
    },
    { filename },
  );

  return moduleUnderTest.exports;
}

function asPlainObject(value) {
  return JSON.parse(JSON.stringify(value));
}
