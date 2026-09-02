import assert from "node:assert/strict";
import test from "node:test";

import { fetchStatus, waitForConsecutiveReadiness } from "../deploy/supabase/validate-application-release.mjs";

function readinessResponse(status, readinessStatus, version = "release-1") {
  return {
    status,
    async json() {
      return { status: readinessStatus, version };
    },
  };
}

function readinessHarness(sequence) {
  let currentTime = 0;
  let calls = 0;
  const requestOptions = [];
  return {
    now: () => currentTime,
    sleep: async (delayMs) => {
      currentTime += delayMs;
    },
    fetchStatusImpl: async (_url, _options, retryOptions) => {
      requestOptions.push(retryOptions);
      const value = sequence[calls];
      calls += 1;
      if (value instanceof Error) throw value;
      return value;
    },
    calls: () => calls,
    requestOptions,
    advance: (milliseconds) => {
      currentTime += milliseconds;
    },
  };
}

test("application validation retries a transient transport failure", async () => {
  let calls = 0;
  const response = { status: 200 };
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return response;
  };

  assert.equal(
    await fetchStatus("https://example.invalid", {}, { fetchImpl, maximumAttempts: 3, retryDelayMs: 0 }),
    response,
  );
  assert.equal(calls, 2);
});

test("application validation tolerates a bounded transport outage longer than the old retry window", async () => {
  let calls = 0;
  const delays = [];
  const response = { status: 200 };
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 5) throw new TypeError("fetch failed");
    return response;
  };

  assert.equal(
    await fetchStatus("https://example.invalid", {}, {
      fetchImpl,
      sleep: async (delayMs) => delays.push(delayMs),
    }),
    response,
  );
  assert.equal(calls, 5);
  assert.deepEqual(delays, [250, 500, 1_000, 2_000]);
});

test("application validation remains fail-closed after the default transport retry budget", async () => {
  let calls = 0;
  const delays = [];
  const fetchImpl = async () => {
    calls += 1;
    throw new TypeError("fetch failed");
  };

  await assert.rejects(
    fetchStatus("https://example.invalid", {}, {
      fetchImpl,
      sleep: async (delayMs) => delays.push(delayMs),
    }),
    /fetch failed/,
  );
  assert.equal(calls, 5);
  assert.deepEqual(delays, [250, 500, 1_000, 2_000]);
});

test("application validation stops retrying when transport recovers to an HTTP failure", async () => {
  let calls = 0;
  const response = { status: 503 };
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return response;
  };

  assert.equal(
    await fetchStatus("https://example.invalid", {}, { fetchImpl, retryDelayMs: 0 }),
    response,
  );
  assert.equal(calls, 2);
});

test("application validation does not retry an HTTP failure response", async () => {
  let calls = 0;
  const response = { status: 503 };
  const fetchImpl = async () => {
    calls += 1;
    return response;
  };

  assert.equal(
    await fetchStatus("https://example.invalid", {}, { fetchImpl, maximumAttempts: 3, retryDelayMs: 0 }),
    response,
  );
  assert.equal(calls, 1);
});

test("application validation remains fail-closed after bounded transport retries", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new TypeError("fetch failed");
  };

  await assert.rejects(
    fetchStatus("https://example.invalid", {}, { fetchImpl, maximumAttempts: 3, retryDelayMs: 0 }),
    /fetch failed/,
  );
  assert.equal(calls, 3);
});

test("readiness requires a fresh five-pass streak after transient failures", async () => {
  const ready = readinessResponse(200, "ready");
  const harness = readinessHarness([
    ready,
    ready,
    readinessResponse(503, "not_ready"),
    ready,
    new TypeError("fetch failed"),
    ready,
    ready,
    ready,
    ready,
    ready,
  ]);

  const result = await waitForConsecutiveReadiness("http://127.0.0.1", "release-1", {
    ...harness,
    pollIntervalMs: 1,
  });

  assert.equal(result, 5);
  assert.equal(harness.calls(), 10);
  assert.ok(harness.requestOptions.every(({ maximumAttempts }) => maximumAttempts === 1));
  assert.ok(harness.requestOptions.every(({ timeoutMs }) => timeoutMs > 0 && timeoutMs <= 5_000));
});

test("readiness fails closed when the observation limit never yields five consecutive passes", async () => {
  const ready = readinessResponse(200, "ready");
  const notReady = readinessResponse(503, "not_ready");
  const harness = readinessHarness([ready, notReady, ready, notReady, ready, notReady]);

  const result = await waitForConsecutiveReadiness("http://127.0.0.1", "release-1", {
    ...harness,
    maximumObservations: 6,
    pollIntervalMs: 1,
  });

  assert.equal(result, 0);
  assert.equal(harness.calls(), 6);
});

test("readiness tolerates a transient outage longer than the old observation budget", async () => {
  const ready = readinessResponse(200, "ready");
  const notReady = readinessResponse(503, "not_ready");
  const harness = readinessHarness([
    ...Array.from({ length: 12 }, () => notReady),
    ready,
    ready,
    ready,
    ready,
    ready,
  ]);

  const result = await waitForConsecutiveReadiness("http://127.0.0.1", "release-1", harness);

  assert.equal(result, 5);
  assert.equal(harness.calls(), 17);
});

test("readiness rejects an unexpected version or malformed body immediately", async (t) => {
  await t.test("unexpected version", async () => {
    const harness = readinessHarness([readinessResponse(200, "ready", "other-release")]);
    assert.equal(
      await waitForConsecutiveReadiness("http://127.0.0.1", "release-1", {
        ...harness,
        pollIntervalMs: 1,
      }),
      0,
    );
    assert.equal(harness.calls(), 1);
  });

  await t.test("malformed body", async () => {
    const harness = readinessHarness([
      {
        status: 200,
        async json() {
          throw new SyntaxError("invalid JSON");
        },
      },
    ]);
    assert.equal(
      await waitForConsecutiveReadiness("http://127.0.0.1", "release-1", {
        ...harness,
        pollIntervalMs: 1,
      }),
      0,
    );
    assert.equal(harness.calls(), 1);
  });

  await t.test("unexpected HTTP status", async () => {
    const harness = readinessHarness([readinessResponse(500, "ready")]);
    assert.equal(
      await waitForConsecutiveReadiness("http://127.0.0.1", "release-1", {
        ...harness,
        pollIntervalMs: 1,
      }),
      0,
    );
    assert.equal(harness.calls(), 1);
  });
});

test("readiness does not count a response completed after its hard deadline", async () => {
  const harness = readinessHarness([readinessResponse(200, "ready")]);
  const fetchStatusImpl = async (...args) => {
    const response = await harness.fetchStatusImpl(...args);
    harness.advance(31);
    return response;
  };

  const result = await waitForConsecutiveReadiness("http://127.0.0.1", "release-1", {
    ...harness,
    fetchStatusImpl,
    windowMs: 30,
    pollIntervalMs: 1,
  });

  assert.equal(result, 0);
  assert.equal(harness.calls(), 1);
  assert.equal(harness.requestOptions[0].maximumAttempts, 1);
  assert.equal(harness.requestOptions[0].timeoutMs, 30);
});

test("readiness stops immediately after five clean consecutive passes", async () => {
  const ready = readinessResponse(200, "ready");
  const harness = readinessHarness([ready, ready, ready, ready, ready, ready]);

  assert.equal(
    await waitForConsecutiveReadiness("http://127.0.0.1", "release-1", {
      ...harness,
      pollIntervalMs: 1,
    }),
    5,
  );
  assert.equal(harness.calls(), 5);
});
