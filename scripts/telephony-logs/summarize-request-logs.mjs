// Aggregates Vercel request-log rows (NDJSON.gz files) into 10-minute buckets.
// Usage: node scripts/telephony-logs/summarize-request-logs.mjs <bucketMinutes> file1.jsonl.gz ...  (PERF_ROUTES=1 adds DB cost per route)
// Times are printed in CEST (UTC+2).
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';

const [, , bucketArg, ...files] = process.argv;
const bucketMs = Number(bucketArg) * 60_000;
const seen = new Set();
const buckets = new Map();
const routes = new Map();
const tz = (ms) => new Date(ms + 2 * 3600_000).toISOString().slice(11, 16); // CEST

function q(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]);
}
function group(path) {
  if (path.startsWith('/api/telephony/telnyx/webhook')) return 'webhook';
  if (path === '/api/telephony/calls/active') return 'calls.active';
  if (path.startsWith('/api/telephony/devices/heartbeat')) return 'heartbeat';
  if (/^\/api\/telephony\/calls\/[^/]+\/(pickup|hangup|hold|unhold|transfer|consult|complete-transfer|add-party|cancel-consult)/.test(path)) return 'call.action';
  if (path.startsWith('/api/telephony/cron')) return 'cron';
  if (path.startsWith('/api/')) return 'other.api';
  return 'page/static';
}
function bucketOf(ms) { return Math.floor(ms / bucketMs) * bucketMs; }
function get(map, key, init) { let v = map.get(key); if (!v) { v = init(); map.set(key, v); } return v; }

for (const file of files) {
  const input = fs.createReadStream(file).pipe(zlib.createGunzip());
  input.on('error', () => {}); // tolerate truncated gzip from crashed workers
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      const key = row.requestId + '|' + row.timestamp + '|' + row.requestPath;
      if (seen.has(key)) continue; seen.add(key);
      const ts = Date.parse(row.timestamp);
      const g = group(row.requestPath || '');
      const b = get(buckets, bucketOf(ts), () => ({ n: 0, groups: {}, webhook: { n: 0, s500: 0, dur: [] }, active: { dur: [] }, perf: { req: 0, dbCount: 0, dbMs: 0, dbMax: [], dbFirst: [], authMs: [] }, perfByRoute: {}, leaseWaits: [], deferrals: {}, cold: 0, fn: 0, instances: new Set(), conc: [] }));
      b.n++; b.groups[g] = (b.groups[g] || 0) + 1;
      const r = get(routes, row.requestPath.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id'), () => ({ n: 0, dur: [], s5xx: 0 }));
      r.n++; if (row.requestDurationMs != null) r.dur.push(row.requestDurationMs); if (row.statusCode >= 500) r.s5xx++;
      if (g === 'webhook') { b.webhook.n++; if (row.statusCode === 500) b.webhook.s500++; if (row.requestDurationMs != null) b.webhook.dur.push(row.requestDurationMs); }
      if (g === 'calls.active' && row.requestDurationMs != null) b.active.dur.push(row.requestDurationMs);
      for (const fe of row.functionEvents || []) {
        b.fn++; if (fe.functionStartType === 'cold') b.cold++; if (fe.instanceId) b.instances.add(fe.instanceId); if (fe.concurrency != null) b.conc.push(fe.concurrency);
      }
      for (const log of row.logs || []) {
        let m; try { m = JSON.parse(log.message); } catch { continue; }
        if (m.scope === 'request-performance') {
          const db = m.steps?.db;
          const key2 = m.route + ':' + m.phase;
          b.perfByRoute[key2] ??= { n: 0, dbCount: 0, dbMs: 0, ms: [] };
          b.perfByRoute[key2].n++; b.perfByRoute[key2].ms.push(m.ms);
          if (db) { b.perfByRoute[key2].dbCount += db.count; b.perfByRoute[key2].dbMs += db.ms; }
          if (db && db.count) { b.perf.req++; b.perf.dbCount += db.count; b.perf.dbMs += db.ms; }
          if (m.dbMaxMs != null) b.perf.dbMax.push(m.dbMaxMs);
          if (m.dbFirstMs != null) b.perf.dbFirst.push(m.dbFirstMs);
          if (m.steps?.auth?.ms != null) b.perf.authMs.push(m.steps.auth.ms);
        } else if (m.scope === 'webhook' && m.deferral) {
          b.deferrals[m.deferral] = (b.deferrals[m.deferral] || 0) + 1;
          if (m.lease_wait_ms != null) b.leaseWaits.push(m.lease_wait_ms);
        }
      }
    }
  } catch { /* truncated */ }
}

const out = [];
out.push(['local', 'req', 'req/s', 'active', 'hb', 'webhook', 'wh500', 'wh_p50', 'wh_p95', 'act_p50', 'act_p95', 'db_req', 'avg_db_ms', 'dbMax_p50', 'dbMax_p95', 'dbFirst_p50', 'auth_p50', 'auth_p95', 'lease_busy', 'cold', 'inst'].join('\t'));
for (const [t, b] of [...buckets.entries()].sort((a, c) => a[0] - c[0])) {
  out.push([
    tz(t), b.n, (b.n / (bucketMs / 1000)).toFixed(1), b.groups['calls.active'] || 0, b.groups['heartbeat'] || 0, b.webhook.n, b.webhook.s500,
    q(b.webhook.dur, 0.5), q(b.webhook.dur, 0.95), q(b.active.dur, 0.5), q(b.active.dur, 0.95),
    b.perf.dbCount, b.perf.dbCount ? Math.round(b.perf.dbMs / b.perf.dbCount) : null, q(b.perf.dbMax, 0.5), q(b.perf.dbMax, 0.95), q(b.perf.dbFirst, 0.5), q(b.perf.authMs, 0.5), q(b.perf.authMs, 0.95),
    b.deferrals.lease_busy || 0, b.cold, b.instances.size,
  ].join('\t'));
}
console.log(out.join('\n'));
console.log('\nTOP ROUTES');
for (const [p, r] of [...routes.entries()].sort((a, c) => c[1].n - a[1].n).slice(0, 30)) {
  console.log([r.n, q(r.dur, 0.5), q(r.dur, 0.95), r.s5xx, p].join('\t'));
}
if (process.env.PERF_ROUTES) {
  console.log('\nPERF BY ROUTE (whole range)');
  const agg = {};
  for (const b of buckets.values()) for (const [k, v] of Object.entries(b.perfByRoute)) {
    agg[k] ??= { n: 0, dbCount: 0, dbMs: 0, ms: [] };
    agg[k].n += v.n; agg[k].dbCount += v.dbCount; agg[k].dbMs += v.dbMs; agg[k].ms.push(...v.ms);
  }
  for (const [k, v] of Object.entries(agg).sort((a, c) => c[1].dbCount - a[1].dbCount).slice(0, 25)) {
    console.log([k, v.n, (v.dbCount / v.n).toFixed(1), v.dbCount, v.dbCount ? Math.round(v.dbMs / v.dbCount) : '-', q(v.ms, 0.5), q(v.ms, 0.95)].join('\t'));
  }
}
