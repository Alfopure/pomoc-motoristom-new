import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Run inside Vercel's source build so maps and deployed JavaScript come from one build.
const enabled = process.env.DIAGNOSTICS_SENTRY_UPLOAD === '1';
if (process.env.NEXT_PUBLIC_DIAGNOSTICS_SENTRY_DSN && !enabled) {
  throw new Error('Sentry DSN requires DIAGNOSTICS_SENTRY_UPLOAD=1 for private maps from this build.');
}
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!enabled) {
  if (process.env.DIAGNOSTICS_PRIVATE_SOURCE_MAPS) throw new Error('Do not enable private source maps outside the managed build.');
  delete process.env.SENTRY_AUTH_TOKEN;
  run('pnpm', ['build']);
} else {
  for (const name of ['NEXT_PUBLIC_DIAGNOSTICS_SENTRY_DSN', 'SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT']) {
    if (!process.env[name]) throw new Error(`Missing private source-map build configuration: ${name}`);
  }
  const pinnedVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).devDependencies['@sentry/cli'];
  process.env.SENTRY_CLI_PATH ||= resolve('node_modules/.bin/sentry-cli');
  const version = spawnSync(process.env.SENTRY_CLI_PATH, ['--version'], { encoding: 'utf8' });
  if (version.error || version.status !== 0 || version.stdout.trim() !== `sentry-cli ${pinnedVersion}`) {
    throw new Error('SENTRY_CLI_PATH must point to the installed, pinned @sentry/cli version.');
  }
  run(process.execPath, ['scripts/diagnostics-source-maps.mjs', 'build']);
  run(process.execPath, ['scripts/diagnostics-source-maps.mjs', 'upload']);
}
