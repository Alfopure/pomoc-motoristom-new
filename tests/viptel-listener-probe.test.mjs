import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const probe = resolve("deploy/bin/probe-viptel-listener.sh");
const writer = resolve("deploy/bin/write-viptel-listener-receipt.py");
const targetRef = "sjcsrygkkmersoczpunh";
const sourceRef = "jcwbiulwuwyrnmzjjbgr";
const version = "hetzner-viptel-probe-test";
const imageId = `sha256:${"a".repeat(64)}`;
const runtimeSha256 = "b".repeat(64);
const fixtureParent = resolve(".context/viptel-listener-probe-tests");
mkdirSync(fixtureParent, { recursive: true, mode: 0o700 });
chmodSync(fixtureParent, 0o700);

function utc(offsetSeconds = 0) {
  return new Date(Date.now() + offsetSeconds * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

function runWriter(receipt, {
  status = "success",
  connected = "true",
  reconnected = "true",
  inbound = "1",
  outbound = "1",
  callWindow = utc(-30),
  callWindowEnd = utc(-15),
} = {}) {
  return spawnSync(
    "python3",
    [
      writer,
      receipt,
      version,
      imageId,
      runtimeSha256,
      status,
      connected,
      reconnected,
      inbound,
      outbound,
      utc(-60),
      callWindow,
      callWindowEnd,
    ],
    { encoding: "utf8" },
  );
}

function privateDirectory(prefix) {
  const root = mkdtempSync(join(fixtureParent, prefix));
  chmodSync(root, 0o700);
  const receipts = join(root, "receipts");
  mkdirSync(receipts, { mode: 0o700 });
  chmodSync(receipts, 0o700);
  return { root, receipts };
}

function targetStatePython() {
  const implementation = readFileSync(probe, "utf8");
  const match = implementation.match(/target_state\(\) \{\n  python3 - .*? <<'PY'\n([\s\S]*?)\nPY\n\}/);
  assert.ok(match, "target_state Python block is missing");
  return match[1];
}

function runCallEvidence(fixtures, { truncateTable } = {}) {
  const fixture = privateDirectory("motorist-viptel-evidence-");
  const runtime = join(fixture.root, "listener.env");
  writeFileSync(runtime, [
    `MOTORIST_ORGANIZATION_SLUG=${JSON.stringify("pomoc-motoristom")}`,
    `SUPABASE_PROJECT_REF=${JSON.stringify(targetRef)}`,
    `SUPABASE_URL=${JSON.stringify(`https://${targetRef}.supabase.co`)}`,
    `SUPABASE_SECRET_KEY=${JSON.stringify("test-secret")}`,
    `SUPABASE_SERVICE_ROLE_KEY=${JSON.stringify("test-secret")}`,
    "",
  ].join("\n"), { mode: 0o600 });
  chmodSync(runtime, 0o600);

  const wrapper = String.raw`
import base64
import json
import os
import urllib.parse
import urllib.request

fixtures = json.loads(os.environ["VIPTEL_TEST_FIXTURES"])
truncate_table = os.environ.get("VIPTEL_TEST_TRUNCATE_TABLE")

class FakeResponse:
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = headers
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, _limit):
        return self.body

def matches(row, field, condition):
    if condition == "not.is.null":
        return row.get(field) is not None
    operator, expected = condition.split(".", 1)
    actual = row.get(field)
    if operator == "eq":
        if isinstance(actual, bool):
            return str(actual).lower() == expected
        return str(actual) == expected
    if operator == "gte":
        return isinstance(actual, str) and actual >= expected
    if operator == "lte":
        return isinstance(actual, str) and actual <= expected
    raise AssertionError(f"unexpected filter: {field}={condition}")

def fake_urlopen(request, timeout=0):
    del timeout
    parsed = urllib.parse.urlparse(request.full_url)
    table = parsed.path.rsplit("/", 1)[-1]
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    rows = [dict(row) for row in fixtures.get(table, [])]
    for field, conditions in query.items():
        if field in {"select", "limit"}:
            continue
        for condition in conditions:
            rows = [row for row in rows if matches(row, field, condition)]
    total = len(rows)
    selected = query.get("select", [""])[0].split(",")
    rows = [{field: row.get(field) for field in selected} for row in rows]
    if truncate_table == table and rows:
        rows = rows[:-1]
    content_range = f"0-{len(rows) - 1}/{total}" if rows else f"*/{total}"
    return FakeResponse(200, {"Content-Range": content_range}, json.dumps(rows).encode())

urllib.request.urlopen = fake_urlopen
source = base64.b64decode(os.environ["VIPTEL_TEST_TARGET_STATE"]).decode()
exec(compile(source, "target-state.py", "exec"))
`;

  const result = spawnSync(
    "python3",
    ["-", runtime, "calls", "2026-07-17T10:00:00Z", "2026-07-17T10:05:00Z"],
    {
      encoding: "utf8",
      input: wrapper,
      env: {
        ...process.env,
        VIPTEL_TEST_FIXTURES: JSON.stringify(fixtures),
        VIPTEL_TEST_TARGET_STATE: Buffer.from(targetStatePython()).toString("base64"),
        VIPTEL_TEST_TRUNCATE_TABLE: truncateTable ?? "",
      },
    },
  );
  rmSync(fixture.root, { recursive: true, force: true });
  return result;
}

const organizationId = "organization-a";
const foreignOrganizationId = "organization-b";

function evidenceFixtures({ calls = [], events = [] } = {}) {
  return {
    motorist_organizations: [
      { id: organizationId, slug: "pomoc-motoristom", active: true },
      { id: foreignOrganizationId, slug: "foreign", active: true },
    ],
    motorist_calls: calls,
    motorist_call_events: events,
  };
}

function call(id, direction, overrides = {}) {
  return {
    id,
    organization_id: organizationId,
    provider: "viptel",
    direction,
    status: "ended",
    created_at: "2026-07-17T10:02:00Z",
    ...overrides,
  };
}

function event(callId, eventType, overrides = {}) {
  return {
    call_id: callId,
    organization_id: organizationId,
    provider: "viptel",
    handled_status: "processed",
    event_type: eventType,
    received_at: "2026-07-17T10:02:01Z",
    ...overrides,
  };
}

test("VIPTel receipt is immutable, mode 0600, bound, and aggregate-only", (t) => {
  const fixture = privateDirectory("motorist-viptel-receipt-");
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const receiptPath = join(fixture.receipts, "success.json");
  const callWindowEnd = utc(-15);
  const result = runWriter(receiptPath, { inbound: "2", outbound: "3", callWindowEnd });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(receiptPath).mode & 0o777, 0o600);

  const raw = readFileSync(receiptPath, "utf8");
  const receipt = JSON.parse(raw);
  assert.equal(receipt.schema, "motorist-viptel-listener/v2");
  assert.equal(receipt.releaseVersion, version);
  assert.equal(receipt.imageId, imageId);
  assert.equal(receipt.runtimeEnvSha256, runtimeSha256);
  assert.equal(receipt.targetProjectRef, targetRef);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.listenerConnected, true);
  assert.equal(receipt.listenerReconnected, true);
  assert.equal(receipt.callWindowEndedAtUtc, callWindowEnd);
  assert.equal(receipt.incomingCallTested, true);
  assert.equal(receipt.outgoingCallTested, true);
  assert.deepEqual(receipt.summary, {
    websocketConnectionsObserved: 2,
    inboundCallsObserved: 2,
    outboundCallsObserved: 3,
  });
  assert.doesNotMatch(raw, /phone|caller|called|destination|username|password|secret/i);
  assert.equal(raw.includes(sourceRef), false);

  const reused = runWriter(receiptPath);
  assert.notEqual(reused.status, 0);
});

test("VIPTel writer refuses a success without every real proof", async (t) => {
  for (const [name, overrides] of [
    ["initial connection", { connected: "false" }],
    ["reconnection", { reconnected: "false" }],
    ["inbound", { inbound: "0" }],
    ["outbound", { outbound: "0" }],
    ["call window", { callWindow: "-" }],
    ["call window end", { callWindowEnd: "-" }],
  ]) {
    await t.test(name, () => {
      const fixture = privateDirectory("motorist-viptel-refusal-");
      try {
        const result = runWriter(join(fixture.receipts, "denied.json"), overrides);
        assert.notEqual(result.status, 0);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("VIPTel writer can retain a safe failed attempt without claiming success", (t) => {
  const fixture = privateDirectory("motorist-viptel-failure-");
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const receiptPath = join(fixture.receipts, "failed.json");
  const result = runWriter(receiptPath, {
    status: "failed",
    connected: "true",
    reconnected: "false",
    inbound: "1",
    outbound: "0",
    callWindow: "-",
    callWindowEnd: "-",
  });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.ok, false);
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.outgoingCallTested, false);
});

test("VIPTel call evidence requires completed WebSocket-linked calls for the configured organization", () => {
  const accepted = runCallEvidence(evidenceFixtures({
    calls: [
      call("inbound-1", "inbound", { created_at: "2026-07-17T10:00:00Z" }),
      call("outbound-1", "outbound", { created_at: "2026-07-17T10:05:00Z" }),
      call("foreign-inbound", "inbound", { organization_id: foreignOrganizationId }),
    ],
    events: [
      event("inbound-1", "queue.join", { received_at: "2026-07-17T10:00:00Z" }),
      event("outbound-1", "call.begin", { received_at: "2026-07-17T10:05:00Z" }),
      event("outbound-1", "call.end"),
      event("foreign-inbound", "call.end", { organization_id: foreignOrganizationId }),
    ],
  }));
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, "1\n1\n");

  const foreignOnly = runCallEvidence(evidenceFixtures({
    calls: [call("foreign-outbound", "outbound", { organization_id: foreignOrganizationId })],
    events: [event("foreign-outbound", "call.end", { organization_id: foreignOrganizationId })],
  }));
  assert.equal(foreignOnly.status, 0, foreignOnly.stderr);
  assert.equal(foreignOnly.stdout, "0\n0\n");
});

test("VIPTel call evidence rejects incomplete, CDR-only, WS-only, and out-of-window calls", () => {
  const result = runCallEvidence(evidenceFixtures({
    calls: [
      call("ringing", "inbound", { status: "ringing_agent" }),
      call("missed", "inbound", { status: "missed" }),
      call("failed", "outbound", { status: "failed" }),
      call("administrative", "inbound"),
      call("cdr-only", "outbound"),
      call("outside", "outbound", { created_at: "2026-07-17T10:05:01Z" }),
    ],
    events: [
      event("ringing", "call.begin"),
      event("missed", "queue.join"),
      event("failed", "call.end"),
      event("administrative", "queue.pause"),
      event("ws-only", "call.end"),
      event("outside", "call.end", { received_at: "2026-07-17T10:05:01Z" }),
    ],
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "0\n0\n");
});

test("VIPTel call evidence counts each completed call once and rejects truncated responses", () => {
  const fixtures = evidenceFixtures({
    calls: [call("inbound-1", "inbound"), call("outbound-1", "outbound")],
    events: [
      event("inbound-1", "queue.join"),
      event("inbound-1", "call.begin"),
      event("outbound-1", "call.begin"),
      event("outbound-1", "call.pickup"),
      event("outbound-1", "call.end"),
    ],
  });
  const deduplicated = runCallEvidence(fixtures);
  assert.equal(deduplicated.status, 0, deduplicated.stderr);
  assert.equal(deduplicated.stdout, "1\n1\n");

  const truncated = runCallEvidence(fixtures, { truncateTable: "motorist_calls" });
  assert.notEqual(truncated.status, 0);
  assert.match(truncated.stderr, /call-evidence response is incomplete/);
});

test("VIPTel candidate probe is real, isolated, bounded, and fail-closed", () => {
  const implementation = readFileSync(probe, "utf8");

  assert.match(implementation, /--acknowledge-real-call-window/);
  assert.match(implementation, /wait_seconds >= 120 && wait_seconds <= 1800/);
  assert.match(implementation, /sha256sum -c SHA256SUMS/);
  assert.match(implementation, /script_dir.*release_dir\/bin/);
  assert.match(implementation, /VIPTEL_LISTENER_ENABLED.*== "false"/s);
  assert.match(implementation, /candidate\["VIPTEL_LISTENER_ENABLED"\] = "true"/);
  assert.match(implementation, /candidate\["VIPTEL_HEALTHCHECKS_PING_URL"\] = ""/);
  assert.match(implementation, /not any\(key\.startswith\("SCHEDULER_"\)/);

  assert.match(implementation, /docker run --detach --rm/);
  assert.match(implementation, /--log-driver none/);
  assert.match(implementation, /--read-only/);
  assert.match(implementation, /--cap-drop ALL\s*\\\n\s*--cap-add DAC_OVERRIDE/);
  assert.match(implementation, /--cap-add SETGID/);
  assert.match(implementation, /--cap-add SETUID/);
  assert.match(implementation, /--security-opt no-new-privileges:true/);
  assert.match(implementation, /source=\$\{candidate_runtime\},target=\/run\/secrets\/runtime_env,readonly/);
  assert.doesNotMatch(implementation, /DAC_READ_SEARCH/);
  assert.match(implementation, /"\$expected_image_id" node runtime-entrypoint\.mjs viptel-listener/);
  assert.match(implementation, /docker inspect --format '\{\{\.Image\}\}'/);
  assert.match(implementation, /docker restart --time 45/);
  assert.match(implementation, /second_started_at/);
  assert.match(implementation, /wait_for_connection "\$second_started_at"/);

  assert.match(implementation, /"GET",\s*table/s);
  assert.match(implementation, /"motorist_call_events"/);
  assert.match(implementation, /"motorist_calls"/);
  assert.match(implementation, /"motorist_organizations"/);
  assert.match(implementation, /\("organization_id", f"eq\.\{organization_id\}"\)/);
  assert.match(implementation, /\("handled_status", "eq\.processed"\)/);
  assert.match(implementation, /call_lifecycle_events = \{/);
  assert.match(implementation, /row\.get\("event_type"\) in call_lifecycle_events/);
  assert.match(implementation, /row\.get\("id"\) in websocket_call_ids/);
  assert.match(implementation, /row\.get\("status"\) == "ended"/);
  assert.match(implementation, /len\(rows\) == total/);
  assert.match(implementation, /\("created_at", f"gte\.\{since\}"\)/);
  assert.match(implementation, /\("created_at", f"lte\.\{until\}"\)/);
  assert.match(implementation, /\("received_at", f"gte\.\{since\}"\)/);
  assert.match(implementation, /\("received_at", f"lte\.\{until\}"\)/);
  assert.doesNotMatch(implementation, /\("started_at", f"gte\./);
  assert.match(implementation, /target_state calls "\$call_window_started_at" "\$call_window_ended_at"/);
  assert.ok(
    implementation.indexOf("call_window_started_at=$(date") < implementation.indexOf("docker restart --time 45"),
    "the only forced reconnect must happen after the real-call window starts",
  );
  assert.doesNotMatch(implementation, /api\/call\/create/);
  assert.doesNotMatch(implementation, /"(?:POST|PATCH|PUT)",\s*"motorist_calls"/);

  assert.ok((implementation.match(/target_state controls/g) ?? []).length >= 4);
  assert.match(implementation, /target_state quiescent "\$probe_id" false/);
  assert.match(implementation, /target_state quiescent "\$probe_id" true/);
  assert.match(implementation, /target_state cleanup "\$probe_id" "\$version"/);
  assert.match(implementation, /failed "\$connected" "\$reconnected"/);
  assert.doesNotMatch(implementation, /docker compose.*(?:up|restart|start)/);
  assert.equal((implementation.match(/docker restart --time 45/g) ?? []).length, 1);
});

test("VIPTel probe refuses to run without explicit real-call acknowledgement", () => {
  const result = spawnSync("bash", [probe, "/missing", "/missing", "/missing", "--wait-seconds", "120"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /acknowledgement is required/);
});
