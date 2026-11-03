#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseLogExport, summarizePerformance } from './lib/call-performance-report.mjs';
const files = process.argv.slice(2);
if (!files.length || files.includes('--help')) {
  console.log('Usage: node scripts/call-performance-report.mjs <runtime-export.jsonl> [more-exports.json ...]\nOutputs JSON with per-environment/build/operation counts, mean, p50/p95/p99, outcomes and coverage. No network or database access.');
  process.exit(files.length ? 0 : 1);
}
const records = [];
for (const file of files) records.push(...parseLogExport(await readFile(file, 'utf8')));
console.log(JSON.stringify(summarizePerformance(records), null, 2));
