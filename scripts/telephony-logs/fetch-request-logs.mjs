// Pages Vercel request-logs backwards in time. `vercel logs` (CLI 51.8) loops on the
// first page because the API ignores `page`; the working cursor is `endDate`.
// Usage: node scripts/telephony-logs/fetch-request-logs.mjs <startISO> <endISO> <out.jsonl.gz>
// Token: VERCEL_TOKEN, else the Vercel CLI login (macOS auth.json). Defaults to the
// production project pomoc-motoristom-dispatching; override with VERCEL_PROJECT_ID / VERCEL_TEAM_ID.
// Run parallel windows (e.g. 30 min each) for a whole test day; rows are NDJSON of the API's request rows.
import fs from 'node:fs';
import zlib from 'node:zlib';
const [,, startIso, endIso, outFile] = process.argv;
if (!startIso || !endIso || !outFile) { console.error('Usage: fetch-request-logs.mjs <startISO> <endISO> <out.jsonl.gz>'); process.exit(1); }
const token = process.env.VERCEL_TOKEN || JSON.parse(fs.readFileSync(process.env.HOME + '/Library/Application Support/com.vercel.cli/auth.json', 'utf8')).token;
const project = process.env.VERCEL_PROJECT_ID || 'prj_DN3smSO1EbGowAmw3nHLQUYoSVJG';
const team = process.env.VERCEL_TEAM_ID || 'team_56GjBnBw6zGSG83LJAnQCB8T';
const base = `https://vercel.com/api/logs/request-logs?projectId=${project}&ownerId=${team}&environment=production&teamId=${team}`;
const start = Date.parse(startIso);
let end = Date.parse(endIso);
const seen = new Set();
const gz = zlib.createGzip();
gz.pipe(fs.createWriteStream(outFile));
let pages = 0, rows = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
while (end > start) {
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`${base}&page=0&startDate=${start}&endDate=${end}`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.status === 429 || r.status >= 500) { if (attempt > 8) throw new Error('HTTP ' + r.status); await sleep(1500 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
      res = await r.json();
      break;
    } catch (e) { if (attempt > 8) throw e; await sleep(1000 * (attempt + 1)); }
  }
  pages++;
  const batch = res.rows ?? [];
  if (!batch.length) break;
  let minTs = Infinity, fresh = 0;
  for (const row of batch) {
    const ts = Date.parse(row.timestamp);
    if (ts < minTs) minTs = ts;
    const key = row.requestId + '|' + row.timestamp + '|' + row.requestPath;
    if (seen.has(key)) continue;
    seen.add(key); fresh++; rows++;
    gz.write(JSON.stringify(row) + '\n');
  }
  if (!res.hasMoreRows) break;
  end = fresh === 0 ? minTs : minTs + 1;
  if (fresh === 0 && batch.every((r) => Date.parse(r.timestamp) === minTs)) end = minTs - 1;
  if (pages % 20 === 0) fs.writeFileSync(outFile + '.progress', JSON.stringify({ pages, rows, at: new Date(end).toISOString() }));
}
fs.writeFileSync(outFile + '.progress', JSON.stringify({ pages, rows, done: true }));
gz.end();
