/** Offline only: consumes log exports, never connects to an application database. */
const environments = new Set(['production', 'test', 'development']);
const label = value => typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,79}$/.test(value) ? value : 'unknown';
const build = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : 'unknown';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const duration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const round = value => Math.round(value * 10) / 10;
// Legacy SDK logs used "development" for TEST phone resources, not the app.
const environmentOf = row => {
  const value = row.scope === 'browser_call_timing' ? row.appEnvironment : row.appEnvironment ?? row.environment;
  return environments.has(value) ? value : 'unknown';
};

export function parseLogExport(text) {
  // JSONL stdout, JSON arrays, Vercel CLI message envelopes, or MCP log exports.
  function unpack(value) {
    if (Array.isArray(value)) return value.flatMap(unpack);
    if (!value || typeof value !== 'object') return [];
    if (typeof value.scope === 'string') return [value];
    if (Array.isArray(value.content)) return value.content.flatMap(item => item.type === 'text' ? lines(item.text) : []);
    if (typeof value.message === 'string') return lines(value.message);
    return [];
  }
  function lines(input) {
    return input.split('\n').flatMap(line => {
      try { return unpack(JSON.parse(line.trim())); } catch { return []; }
    });
  }
  try { return unpack(JSON.parse(text)); } catch { return lines(text); }
}

export function statistics(values) {
  const sorted = values.filter(duration).sort((a, b) => a - b);
  const percentile = p => sorted.length ? round(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]) : null;
  return { count: sorted.length, meanMs: sorted.length ? round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
    p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: percentile(1) };
}

export function summarizePerformance(records) {
  const groups = new Map(), seen = new Set(), browser = new Map();
  const coverage = { inputRecords: records.length, duplicates: 0, invalidDuration: 0, missingIdentity: 0, backgroundRecords: 0,
    unrecognized: 0, reportedBrowserDrops: 0, unmatchedAnswers: 0, ambiguousAnswers: 0, browserLegs: 0,
    unknownClientBuild: 0, unknownRequestBuild: 0, answersEndedWithoutActive: 0 };
  const add = (row, measurement, operation, ms, outcome) => {
    const environment = environmentOf(row);
    // The telemetry receiver can be newer than both the request and the open tab.
    const buildKind = measurement === 'handler_response' ? 'server' : measurement === 'request_roundtrip' ? 'request_server' : 'client';
    const measuredBuild = build(buildKind === 'server' ? row.serverBuild : buildKind === 'request_server' ? row.requestBuild : row.clientBuild);
    const clientBuild = buildKind === 'server' ? 'not_applicable' : build(row.clientBuild);
    const key = JSON.stringify([environment, measuredBuild, clientBuild, measurement, label(operation)]);
    const group = groups.get(key) ?? { environment, build: measuredBuild, buildKind, clientBuild, measurement, operation: label(operation),
      outcomes: {}, durations: [], successful: [], accepted: [], byOutcome: new Map(), steps: new Map(), databaseTimeouts: 0, invalidDuration: 0 };
    group.outcomes[outcome] = (group.outcomes[outcome] ?? 0) + 1;
    groups.set(key, group);
    if (Number.isSafeInteger(row.dbAborts) && row.dbAborts >= 0) group.databaseTimeouts += row.dbAborts;
    if (row.steps && typeof row.steps === 'object') for (const [step, metric] of Object.entries(row.steps)) {
      if (!/^(auth(\.(token|profile))?|db|lease|provider|checkpoint|read|write|routing\.(snapshot|configuration|eligibility)|guard\.stage|control\.(recording\.(admission|ack)|participants|projection|audit|finalize|staging))$/.test(step) || !duration(metric?.ms)) continue;
      const values = group.steps.get(step) ?? []; values.push(metric.ms); group.steps.set(step, values);
    }
    // A missing clock must not erase a known failure (or cancellation) from the denominator.
    if (!duration(ms)) { coverage.invalidDuration++; group.invalidDuration++; return; }
    const outcomeDurations = group.byOutcome.get(outcome) ?? [];
    outcomeDurations.push(ms); group.byOutcome.set(outcome, outcomeDurations);
    // Cancellation is counted but not interpreted as a completed technical operation.
    if (outcome !== 'cancelled') group.durations.push(ms);
    if (outcome === 'ok') group.successful.push(ms);
    if (outcome === 'accepted') group.accepted.push(ms);
  };
  for (const row of records) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) { coverage.unrecognized++; continue; }
    if (row.scope === 'call-performance-coverage') {
      if (Number.isSafeInteger(row.dropped) && row.dropped > 0 && row.dropped <= 10_000) coverage.reportedBrowserDrops += row.dropped;
      continue;
    }
    if (!['request-performance', 'call-request-performance', 'browser_call_timing'].includes(row.scope)) { coverage.unrecognized++; continue; }
    // Background callbacks can share an ID and phase; never treat them as requests or deduplicate them into a latency.
    if (row.scope === 'request-performance' && row.phase !== 'response') { coverage.backgroundRecords++; continue; }
    const identity = row.scope === 'request-performance' ? row.requestId : row.scope === 'browser_call_timing' ? row.observationId : row.id;
    if (!uuid(identity)) { coverage.missingIdentity++; continue; }
    const key = [row.scope, environmentOf(row), identity].join(':');
    if (seen.has(key)) { coverage.duplicates++; continue; } seen.add(key);
    if (row.scope === 'request-performance') {
      if (!Number.isInteger(row.status) || row.status < 100 || row.status > 599) { coverage.unrecognized++; continue; }
      add(row, 'handler_response', row.operation ?? row.route, row.ms, row.status === 202 ? 'accepted' : row.status < 400 ? 'ok' : 'failed');
    } else if (row.scope === 'call-request-performance') {
      if (!['ok', 'accepted', 'failed', 'timeout', 'cancelled'].includes(row.outcome)) { coverage.unrecognized++; continue; }
      if (build(row.clientBuild) === 'unknown') coverage.unknownClientBuild++;
      if (build(row.requestBuild) === 'unknown') coverage.unknownRequestBuild++;
      add(row, 'request_roundtrip', row.operation, row.ms, row.outcome);
    } else {
      if (!uuid(row.pageId) || !uuid(row.legId) || !duration(row.browserMonotonicMs)) { coverage.unrecognized++; continue; }
      if (build(row.clientBuild) === 'unknown') coverage.unknownClientBuild++;
      // One monotonic clock survives a deployment on the receiving server.
      const legKey = [environmentOf(row), row.pageId, row.legId].join(':');
      const phases = browser.get(legKey) ?? []; phases.push(row); browser.set(legKey, phases);
      if (row.phase === 'ringtone_start' && row.durationMs !== undefined && ['ok', 'failed'].includes(row.outcome)) add(row, 'ringtone_playback', 'call.ringtone', row.durationMs, row.outcome);
    }
  }
  for (const phases of browser.values()) {
    coverage.browserLegs++;
    const requested = phases.filter(row => row.phase === 'answer_requested');
    const active = phases.filter(row => row.phase === 'sdk_active');
    if (!requested.length) continue;
    if (requested.length !== 1 || active.length > 1) { coverage.ambiguousAnswers++; continue; }
    if (!active.length) {
      coverage.unmatchedAnswers++;
      if (phases.some(row => row.phase === 'sdk_ended' && row.browserMonotonicMs >= requested[0].browserMonotonicMs)) coverage.answersEndedWithoutActive++;
      continue;
    }
    // Same page, same leg, same monotonic clock. Never invite -> answer (human waiting).
    const request = requested[0];
    if (build(request.clientBuild) !== build(active[0].clientBuild) || phases.some(row => row.phase === 'sdk_ended' &&
      row.browserMonotonicMs >= request.browserMonotonicMs && row.browserMonotonicMs < active[0].browserMonotonicMs)) {
      coverage.ambiguousAnswers++; continue;
    }
    const mode = ['manual', 'automatic'].includes(request.answerMode) ? request.answerMode : 'unknown';
    add(request, 'answer_to_active', `call.answer.${mode}`,
      active[0].browserMonotonicMs - request.browserMonotonicMs, 'ok');
  }
  return { schemaVersion: 2, coverage, groups: [...groups.values()].map(group => {
    const { durations, successful, accepted, byOutcome, steps, ...meta } = group;
    return { ...meta, observed: statistics(durations), successful: statistics(successful), accepted: statistics(accepted),
      byOutcome: Object.fromEntries([...byOutcome].map(([name, values]) => [name, statistics(values)])),
      stages: Object.fromEntries([...steps].map(([name, values]) => [name, statistics(values)])) };
  }).sort((a,b) => JSON.stringify([a.environment,a.build,a.clientBuild,a.measurement,a.operation]).localeCompare(JSON.stringify([b.environment,b.build,b.clientBuild,b.measurement,b.operation]))),
  limitations: ['The export window and retention determine coverage; missing logs are not successes.',
    'Browser measurements are best effort observations; received rows cannot prove 100% coverage.',
    '202 measures acceptance, not completed hangup or media connection. Timeouts are lower bounds, not completed durations.',
    'Successful percentiles exclude failures and cancellations; inspect outcome counts alongside them.',
    'Stage times overlap: never add them or subtract their sum from handler wall time.',
    'ok describes HTTP/SDK observation, not confirmed customer audio or a completed call-control effect.',
    'Build attribution uses the request response header or the emitting client build, never the later telemetry receiver. Legacy provenance stays unknown.',
    'Browser wall timestamps locate observations approximately; only same-page monotonic clocks determine browser durations.',
    'Missing duration retains the observed outcome count but contributes no latency; inspect unmatched and ambiguous SDK answers too.',
    'Invite-to-answer and waiting-room dwell are not latency metrics. Repeated captured answer attempts are excluded; legacy clients may have hidden retries.'] };
}
