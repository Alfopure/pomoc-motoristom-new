import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const root = process.cwd(), baseline = '6c314610327d383f95e381c9fa30422d89fe57ad';
const old = path.join(root, '.context/compat-baseline');
mkdirSync(old, { recursive: true });
{
    const archive = execFileSync('git', ['archive', baseline, 'src', 'tsconfig.json'], { maxBuffer: 30 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', old], { input: archive });
}
const entry = `export * from '@/test/telephony-harness';
export * from '@/server/telephony/call-actions';
export * from '@/server/telephony/presence-service';
export * from '@/server/telephony/cron-jobs';
export * from '@/server/telephony/routing/ring-plan';
export * from '@/server/telephony/session-runner';
export * from '@/server/telephony/callbacks';
export * from '@/server/telephony/contact-proof';
export { encodeClientState } from '@/server/telephony/telnyx/client-state';
export * from '@/server/telephony/state/continuation';
export { setCallOutcome } from '@/server/telephony-workflow';`;
for (const [name, source] of [['writer', root], ['baseline', old]]) {
    await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, outfile: path.join(root, `.context/compat-${name}.cjs`), bundle: true, platform: 'node', format: 'cjs', packages: 'external', alias: { '@': path.join(source, 'src'), 'server-only': path.join(root, 'src/test/stubs/server-only.ts') }, plugins: [{ name: 'local-boundaries', setup(b) {
                    b.onResolve({ filter: /^@\/(lib\/supabase\/(admin|env)|data\/dispatch-repository)$/ }, args => ({ path: args.path, namespace: 'compat' }));
                    b.onLoad({ filter: /.*/, namespace: 'compat' }, args => ({ contents: args.path.endsWith('/admin') ? 'export const createSupabaseAdminClient=()=>globalThis.__compatAdmin;' : args.path.endsWith('/env') ? 'export const getSupabaseServiceEnv=()=>({url:"http://127.0.0.1",serviceRoleKey:"local-fixture"}); export const getSupabasePublicEnv=()=>null;' : 'export const loadDispatchData=()=>({compatibilityFixture:true});', loader: 'js' }));
                } }] });
}
writeFileSync(path.join(root, '.context/compat-source.json'), JSON.stringify({ baseline, writerHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), runtimeDelta: execFileSync('git', ['diff', '--stat', baseline, 'HEAD', '--', 'src'], { encoding: 'utf8' }).trim(), workingSourceDelta: execFileSync('git', ['diff', '--stat', '--', 'src'], { encoding: 'utf8' }).trim(), baselineSource: 'git archive (immutable SHA)', writerSource: 'working tree' }, null, 2));
