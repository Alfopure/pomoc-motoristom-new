// Per webhook event type / call action: handler time and DB cost, split by local time window.
// Usage: node scripts/telephony-logs/webhook-cost-by-window.mjs file1.jsonl.gz ...
// Edit WINDOWS (UTC HH:MM) for the test day being compared.
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';

const files = process.argv.slice(2);
const seen = new Set();
const WINDOWS = [
  ['07:40-08:10 rano', '05:40', '06:10'],
  ['09:00-09:50 dopoludnie', '07:00', '07:50'],
  ['11:30-11:50 pred obedom', '09:30', '09:50'],
  ['12:10-12:40 obed', '10:10', '10:40'],
  ['13:00-13:20 po obede', '11:00', '11:20'],
];
const win = (iso) => { const hm = iso.slice(11, 16); const w = WINDOWS.find(([, a, b]) => hm >= a && hm < b); return w ? w[0] : null; };
const stats = new Map();
const add = (k, v) => { let s = stats.get(k); if (!s) { s = { ms: [], db: [], dbms: [], ok: 0, fail: 0 }; stats.set(k, s); } s.ms.push(v.ms); s.db.push(v.db); s.dbms.push(v.dbms); if (v.ok) s.ok++; else s.fail++; };
const q = (a, p) => { if (!a.length) return '-'; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };

for (const file of files) {
  const input = fs.createReadStream(file).pipe(zlib.createGunzip()); input.on('error', () => {});
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try { for await (const line of rl) {
    if (!line.includes('/api/telephony/')) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    const key = row.requestId + row.timestamp + row.requestPath; if (seen.has(key)) continue; seen.add(key);
    const w = win(row.timestamp); if (!w) continue;
    const msgs = (row.logs || []).map((l) => { try { return JSON.parse(l.message); } catch { return null; } }).filter(Boolean);
    const perf = msgs.find((m) => m.scope === 'request-performance' && m.phase === 'response');
    if (!perf) continue;
    const db = perf.steps?.db?.count ?? 0; const dbms = perf.steps?.db?.ms ?? 0;
    if (row.requestPath.startsWith('/api/telephony/telnyx/webhook')) {
      const del = msgs.find((m) => m.scope === 'webhook-delivery' && m.meta?.attempt != null) || msgs.find((m) => m.scope === 'webhook-delivery');
      const type = del?.type ?? '?';
      const outcome = del?.outcome ?? '?';
      const cls = row.statusCode === 200 ? 'ok' : 'deferred';
      add(`${w}|webhook ${type} ${cls}`, { ms: perf.ms, db, dbms, ok: row.statusCode === 200 });
      add(`${w}|webhook ALL`, { ms: perf.ms, db, dbms, ok: row.statusCode === 200 });
    } else {
      const m = row.requestPath.match(/^\/api\/telephony\/calls\/[^/]+\/([a-z-]+)$/);
      if (m) add(`${w}|action ${m[1]}`, { ms: perf.ms, db, dbms, ok: row.statusCode < 400 });
      else if (row.requestPath === '/api/telephony/calls/active') add(`${w}|calls/active`, { ms: perf.ms, db, dbms, ok: row.statusCode < 400 });
    }
  } } catch {}
}
console.log(['window', 'what', 'n', 'ok', 'fail/500', 'ms_p50', 'ms_p90', 'ms_max', 'db_req_p50', 'db_ms_per_req'].join('\t'));
for (const [k, s] of [...stats.entries()].sort()) {
  const [w, what] = k.split('|');
  if (s.ms.length < 3 && !what.startsWith('action')) continue;
  const perReq = s.db.reduce((a, b) => a + b, 0) ? Math.round(s.dbms.reduce((a, b) => a + b, 0) / s.db.reduce((a, b) => a + b, 0)) : '-';
  console.log([w, what, s.ms.length, s.ok, s.fail, q(s.ms, 0.5), q(s.ms, 0.9), q(s.ms, 1), q(s.db, 0.5), perReq].join('\t'));
}
