import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'diagnostics-build-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'scripts'));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({devDependencies:{'@sentry/cli':'3.8.0'}}));
  for (const file of ['diagnostics-source-maps.mjs', 'diagnostics-vercel-build.mjs']) cpSync(resolve('scripts', file), join(cwd, 'scripts', file));
  mkdirSync(join(cwd, 'bin'));
  writeFileSync(join(cwd, 'bin/pnpm'), `#!/usr/bin/env node
if(process.env.SENTRY_AUTH_TOKEN)process.exit(99);const fs=require('node:fs');fs.appendFileSync('commands.log','build\\n');
if(process.env.DIAGNOSTICS_PRIVATE_SOURCE_MAPS==='1'){fs.mkdirSync('.next/static/chunks',{recursive:true});fs.writeFileSync('.next/static/chunks/abcdefgh.js',(process.env.FAKE_INLINE_REFERENCE?'const text="//# sourceMappingURL=missing.map";\\n':'')+'compiled\\n//# sourceMappingURL=maphash123.js.map');fs.writeFileSync('.next/static/chunks/maphash123.js.map','map');}
if(process.env.FAKE_COPY_BLOCK)fs.mkdirSync('.context/diagnostics-source-maps/exact_release/chunks/maphash123.js.map',{recursive:true});
process.exit(Number(process.env.FAKE_BUILD_EXIT||0));`, { mode: 0o755 });
  const cli = join(cwd, 'bin/sentry-cli');
  writeFileSync(cli, `#!/usr/bin/env node
const fs=require('node:fs');if(process.argv[2]==='--version'){console.log('sentry-cli '+(process.env.FAKE_CLI_VERSION||'3.8.0'));process.exit(0);}
fs.appendFileSync('commands.log','upload\\n');fs.writeFileSync('upload.json',JSON.stringify(process.argv.slice(2)));process.exit(Number(process.env.FAKE_UPLOAD_EXIT||0));`, { mode: 0o755 });
  const env = { PATH: `${join(cwd, 'bin')}:${process.env.PATH}`, DEPLOYMENT_VERSION: 'exact_release', SENTRY_CLI_PATH: cli, SENTRY_AUTH_TOKEN: 'private-token', SENTRY_ORG: 'org', SENTRY_PROJECT: 'test-project' };
  const run = (file, args = [], extra = {}) => spawnSync(process.execPath, [`scripts/${file}.mjs`, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
  return { cwd, run, enabled: { DIAGNOSTICS_SENTRY_UPLOAD: '1', NEXT_PUBLIC_DIAGNOSTICS_SENTRY_DSN: 'https://public@example.test/1' } };
}
test('ordinary build preserves no-upload behavior', t => {
  const { cwd, run } = fixture(t);
  assert.equal(run('diagnostics-vercel-build').status, 0);
  assert.equal(readFileSync(join(cwd, 'commands.log'), 'utf8'), 'build\n');
  assert.equal(existsSync(join(cwd, '.context')), false);
});
test('same build uploads exact release only after stripping public maps', t => {
  const { cwd, run, enabled } = fixture(t);
  const result = run('diagnostics-vercel-build', [], enabled);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(cwd, 'commands.log'), 'utf8'), 'build\nupload\n');
  assert.equal(existsSync(join(cwd, '.next/static/chunks/maphash123.js.map')), false);
  assert.equal(readFileSync(join(cwd, '.next/static/chunks/abcdefgh.js'), 'utf8'), 'compiled\n//# sourceMappingURL=maphash123.js.map');
  const args = JSON.parse(readFileSync(join(cwd, 'upload.json')));
  assert.deepEqual(args.slice(0, 7), ['sourcemaps', 'upload', '--release', 'exact_release', '--url-prefix', '~/_next/static', '--validate']);
  assert.equal(JSON.stringify(args).includes('private-token'), false);
});
test('failed build removes maps and never uploads', t => {
  const { cwd, run, enabled } = fixture(t);
  assert.equal(run('diagnostics-vercel-build', [], { ...enabled, FAKE_BUILD_EXIT: '7' }).status, 7);
  assert.equal(existsSync(join(cwd, '.next/static/chunks/maphash123.js.map')), false);
  assert.equal(existsSync(join(cwd, 'upload.json')), false);
  assert.notEqual(run('diagnostics-source-maps', ['upload']).status, 0);
});
test('upload failure is visible with no public maps', t => {
  const { cwd, run, enabled } = fixture(t);
  assert.equal(run('diagnostics-vercel-build', [], { ...enabled, FAKE_UPLOAD_EXIT: '8' }).status, 8);
  assert.equal(existsSync(join(cwd, '.next/static/chunks/maphash123.js.map')), false);
});
test('DSN without managed upload and CLI pin mismatch fail before building', t => {
  const { cwd, run, enabled } = fixture(t);
  assert.notEqual(run('diagnostics-vercel-build', [], { NEXT_PUBLIC_DIAGNOSTICS_SENTRY_DSN: enabled.NEXT_PUBLIC_DIAGNOSTICS_SENTRY_DSN }).status, 0);
  assert.notEqual(run('diagnostics-vercel-build', [], { ...enabled, FAKE_CLI_VERSION: 'wrong' }).status, 0);
  assert.equal(existsSync(join(cwd, 'commands.log')), false);
});
test('tampered artifact is rejected before upload', t => {
  const { cwd, run } = fixture(t);
  assert.equal(run('diagnostics-source-maps', ['build']).status, 0);
  writeFileSync(join(cwd, '.context/diagnostics-source-maps/exact_release/chunks/abcdefgh.js'), 'different');
  assert.notEqual(run('diagnostics-source-maps', ['upload']).status, 0);
  assert.equal(existsSync(join(cwd, 'upload.json')), false);
});
test('retry removes stale artifacts for the same release', t => {
  const { cwd, run } = fixture(t);
  assert.equal(run('diagnostics-source-maps', ['build']).status, 0);
  const stale = join(cwd, '.context/diagnostics-source-maps/exact_release/stale.js');
  writeFileSync(stale, 'old');
  assert.equal(run('diagnostics-source-maps', ['build']).status, 0);
  assert.equal(existsSync(stale), false);
});
test('different deployment JavaScript is rejected before upload', t => {
  const { cwd, run } = fixture(t);
  assert.equal(run('diagnostics-source-maps', ['build']).status, 0);
  writeFileSync(join(cwd, '.next/static/chunks/abcdefgh.js'), 'rebuilt');
  assert.notEqual(run('diagnostics-source-maps', ['upload']).status, 0);
  assert.equal(existsSync(join(cwd, 'upload.json')), false);
});

test('artifact-copy failure still strips public maps and never uploads', t => {
  const { cwd, run, enabled } = fixture(t);
  assert.notEqual(run('diagnostics-vercel-build', [], { ...enabled, FAKE_COPY_BLOCK: '1' }).status, 0);
  assert.equal(existsSync(join(cwd, '.next/static/chunks/maphash123.js.map')), false);
  assert.equal(existsSync(join(cwd, 'upload.json')), false);
});

test('embedded source-map text is ignored in favor of the emitted reference', t => {
  const { run, enabled } = fixture(t);
  const result = run('diagnostics-vercel-build', [], { ...enabled, FAKE_INLINE_REFERENCE: '1' });
  assert.equal(result.status, 0, result.stderr);
});
