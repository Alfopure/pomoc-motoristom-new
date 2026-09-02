import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/lib/telephony/webphone.ts", import.meta.url), "utf8");
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
    process: { env: {} },
    require,
  },
  { filename: "src/lib/telephony/webphone.ts" },
);

const { getViptelWebphoneConfig, getViptelWebphoneSession, isViptelBrowserCredentialExposureEnabled, ViptelWebphoneSessionError } = moduleUnderTest.exports;

test("builds ready webphone config while redacting browser credentials by default", () => {
  const config = getViptelWebphoneConfig({
    VIPTEL_SIP_WEBPHONE_ENABLED: "true",
    VIPTEL_SIP_WS_URL: "wss://pbxwssv1.viptel.sk/",
    VIPTEL_SIP_DOMAIN: "pomocmotor.cloud.viptel.sk",
    VIPTEL_SIP_REALM: "pomocmotor.cloud.viptel.sk",
    VIPTEL_SIP_BROWSER_REGISTRATION_ALLOWED: "true",
    VIPTEL_SIP_ALLOWED_ORIGINS: "http://localhost:3000,https://dispatch.example.test",
    VIPTEL_SIP_CODECS: "opus,G722,PCMU,PCMA,GSM",
    VIPTEL_SIP_DTMF_MODE: "rfc2833",
    VIPTEL_WEBPHONE_EXTENSIONS: "11,12",
    VIPTEL_WEBPHONE_11_AUTH_USERNAME: "11",
    VIPTEL_WEBPHONE_11_PASSWORD: "secret-11",
    VIPTEL_WEBPHONE_11_OUTBOUND_CALLER_ID: "0412289133",
    VIPTEL_WEBPHONE_12_AUTH_USERNAME: "12",
    VIPTEL_WEBPHONE_12_PASSWORD: "secret-12",
  });

  assert.equal(config.status, "ready");
  assert.equal(config.dialMode, "sip_invite");
  assert.equal(config.sipWebSocketUrl, "wss://pbxwssv1.viptel.sk/");
  assert.deepEqual([...config.codecs], ["opus", "G722", "PCMU", "PCMA", "GSM"]);
  assert.equal(config.credentialsExposure, "redacted");
  assert.deepEqual([...config.allowedOrigins], ["http://localhost:3000", "https://dispatch.example.test"]);
  assert.equal(config.extensions.length, 2);
  assert.equal(config.extensions[0].passwordConfigured, true);
  assert.equal(config.extensions[0].password, undefined);
});

test("can explicitly include browser test credentials", () => {
  const config = getViptelWebphoneConfig(
    {
      VIPTEL_SIP_WS_URL: "wss://sip.example.test/ws",
      VIPTEL_SIP_DOMAIN: "sip.example.test",
      VIPTEL_SIP_BROWSER_REGISTRATION_ALLOWED: "true",
      VIPTEL_SIP_CODECS: "opus",
      VIPTEL_WEBPHONE_EXTENSIONS_JSON: JSON.stringify([
        {
          extension: "13",
          label: "Test 3",
          authUsername: "13",
          password: "secret-13",
          outboundCallerId: "0412289133",
          canCallExternal: true,
        },
      ]),
    },
    { includeSecrets: true },
  );

  assert.equal(config.credentialsExposure, "browser_test");
  assert.equal(config.extensions[0].password, "secret-13");
  assert.equal(config.extensions[0].canCallExternal, true);
});

test("marks browser registration denial as blocked", () => {
  const config = getViptelWebphoneConfig({
    VIPTEL_SIP_WEBPHONE_ENABLED: "true",
    VIPTEL_SIP_WS_URL: "wss://sip.example.test/ws",
    VIPTEL_SIP_DOMAIN: "sip.example.test",
    VIPTEL_SIP_BROWSER_REGISTRATION_ALLOWED: "false",
    VIPTEL_SIP_CODECS: "opus",
    VIPTEL_WEBPHONE_EXTENSIONS: "11",
    VIPTEL_WEBPHONE_11_PASSWORD: "secret-11",
  });

  assert.equal(config.status, "blocked");
});

test("reads explicit credential exposure flag", () => {
  assert.equal(isViptelBrowserCredentialExposureEnabled({ VIPTEL_SIP_EXPOSE_BROWSER_CREDENTIALS: "true" }), true);
  assert.equal(isViptelBrowserCredentialExposureEnabled({ VIPTEL_SIP_EXPOSE_BROWSER_CREDENTIALS: "false" }), false);
});

test("creates browser webphone session only for the selected test extension", () => {
  const session = getViptelWebphoneSession(
    {
      VIPTEL_SIP_EXPOSE_BROWSER_CREDENTIALS: "true",
      VIPTEL_SIP_WEBPHONE_ENABLED: "true",
      VIPTEL_SIP_WS_URL: "wss://sip.example.test/ws",
      VIPTEL_SIP_DOMAIN: "sip.example.test",
      VIPTEL_SIP_REALM: "sip.example.test",
      VIPTEL_SIP_BROWSER_REGISTRATION_ALLOWED: "true",
      VIPTEL_SIP_CODECS: "opus,PCMA",
      VIPTEL_SIP_DTMF_MODE: "rfc2833",
      VIPTEL_WEBPHONE_EXTENSIONS: "11,12",
      VIPTEL_WEBPHONE_11_AUTH_USERNAME: "11",
      VIPTEL_WEBPHONE_11_PASSWORD: "secret-11",
      VIPTEL_WEBPHONE_12_AUTH_USERNAME: "12",
    },
    "11",
  );

  assert.equal(session.credentialsExposure, "browser_test");
  assert.equal(session.extension.extension, "11");
  assert.equal(session.extension.authUsername, "11");
  assert.equal(session.extension.password, "secret-11");
  assert.equal(session.codecs.join(","), "opus,PCMA");
  assert.equal(session.dtmfMode, "rfc2833");
});

for (const invalidMode of [undefined, "sip-info", "auto"]) {
  test(`blocks browser credentials for ${invalidMode ?? "missing"} DTMF mode`, () => {
    const env = browserSessionEnv(invalidMode);
    const config = getViptelWebphoneConfig(env);
    assert.ok(config.missingFields.includes("VIPTEL_SIP_DTMF_MODE (rfc2833 or rfc4733)"));
    assert.notEqual(config.status, "ready");
    assert.throws(
      () => getViptelWebphoneSession(env, "11"),
      (error) => error instanceof ViptelWebphoneSessionError && error.status === 409,
    );
  });
}

for (const mode of ["rfc2833", "rfc4733"]) {
  test(`issues a browser session with the explicit ${mode} RTP DTMF mode`, () => {
    const session = getViptelWebphoneSession(browserSessionEnv(mode), "11");
    assert.equal(session.dtmfMode, mode);
  });
}

test("rejects production extension for browser webphone session", () => {
  assert.throws(
    () => getViptelWebphoneSession({ VIPTEL_SIP_EXPOSE_BROWSER_CREDENTIALS: "true" }, "10"),
    (error) => error instanceof ViptelWebphoneSessionError && error.status === 400,
  );
});

test("rejects browser webphone session when credential exposure is disabled", () => {
  assert.throws(
    () => getViptelWebphoneSession({ VIPTEL_SIP_EXPOSE_BROWSER_CREDENTIALS: "false" }, "11"),
    (error) => error instanceof ViptelWebphoneSessionError && error.status === 403,
  );
});

test("rejects browser webphone session when the main webphone switch is disabled", () => {
  assert.throws(
    () => getViptelWebphoneSession({ ...browserSessionEnv("rfc2833"), VIPTEL_SIP_WEBPHONE_ENABLED: "false" }, "11"),
    (error) => error instanceof ViptelWebphoneSessionError && error.status === 503,
  );
});

function browserSessionEnv(dtmfMode) {
  return {
    VIPTEL_SIP_EXPOSE_BROWSER_CREDENTIALS: "true",
    VIPTEL_SIP_WEBPHONE_ENABLED: "true",
    VIPTEL_SIP_WS_URL: "wss://sip.example.test/ws",
    VIPTEL_SIP_DOMAIN: "sip.example.test",
    VIPTEL_SIP_REALM: "sip.example.test",
    VIPTEL_SIP_BROWSER_REGISTRATION_ALLOWED: "true",
    VIPTEL_SIP_CODECS: "opus,PCMA",
    VIPTEL_SIP_DTMF_MODE: dtmfMode,
    VIPTEL_WEBPHONE_EXTENSIONS: "11",
    VIPTEL_WEBPHONE_11_AUTH_USERNAME: "11",
    VIPTEL_WEBPHONE_11_PASSWORD: "secret-11",
  };
}
