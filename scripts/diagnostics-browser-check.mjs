import { spawnSync } from 'node:child_process';
import chromium from '@sparticuz/chromium';

// The existing pinned deployment dependency includes Chromium, so the build
// gate needs no browser download, credentials, running app or live calls.
const executablePath = process.env.DIAGNOSTICS_CHROMIUM_PATH || await chromium.executablePath();
const result = spawnSync('pnpm', ['exec', 'playwright', 'test', '--config', 'playwright.audit.config.ts'], {
  stdio: 'inherit', env: { ...process.env, SENTRY_AUTH_TOKEN: undefined,
    DIAGNOSTICS_CHROMIUM_PATH: executablePath,
    DIAGNOSTICS_SERVERLESS_CHROMIUM: process.env.DIAGNOSTICS_SERVERLESS_CHROMIUM ?? (process.env.DIAGNOSTICS_CHROMIUM_PATH ? '0' : '1') },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
