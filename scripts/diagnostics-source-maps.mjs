import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, copyFileSync, unlinkSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
const mode = process.argv[2];
const release = process.env.DEPLOYMENT_VERSION || process.env.VERCEL_GIT_COMMIT_SHA;
if (!release || !/^[a-zA-Z0-9_-]{1,64}$/.test(release)) throw new Error('Set the exact immutable DEPLOYMENT_VERSION (safe release ID, max 64 characters).');
const artifact = resolve('.context/diagnostics-source-maps', release);
const bundles = [
  { kind: 'browser', root: resolve('.next/static'), prefix: '~/_next/static' },
  { kind: 'server', root: resolve('.next/server'), prefix: 'app:///server' },
];
function files(directory) { return existsSync(directory) ? readdirSync(directory,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(directory,e.name)):[join(directory,e.name)]) : []; }
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function sourceMapPath(reference, javascript, root) {
  // Turbopack URI-encodes brackets in server chunk names. Decode once, then
  // require a local relative file inside this bundle; URLs are never fetched.
  const decoded = decodeURIComponent(reference);
  if (!decoded || /^[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.startsWith('/') || /[\\?#\0]/.test(decoded)) {
    throw new Error('Invalid private source-map reference.');
  }
  const map = resolve(javascript, '..', decoded);
  if (!map.startsWith(root + '/')) throw new Error('Private source-map reference escapes its bundle.');
  return map;
}
if (mode === 'build') {
  // A retry of the same release must never upload stale artifacts from a prior build.
  rmSync(artifact, { recursive: true, force: true });
  const result = spawnSync('pnpm',['build'],{stdio:'inherit',env:{...process.env,DIAGNOSTICS_PRIVATE_SOURCE_MAPS:'1',SENTRY_AUTH_TOKEN:undefined}});
  const allMaps = bundles.flatMap(bundle => files(bundle.root).filter(file => file.endsWith('.map')));
  try {
    const manifest = { release, buildSucceeded: result.status === 0, bundles: [], files: [] };
    for (const {kind,root,prefix} of bundles) {
      const maps = files(root).filter(file => file.endsWith('.map'));
      const mapSet = new Set(maps), matched = new Set();
      for (const map of maps) {
        const target = join(artifact,kind,relative(root,map));
        mkdirSync(resolve(target,'..'),{recursive:true}); copyFileSync(map,target);
      }
      for (const javascript of files(root).filter(file => file.endsWith('.js'))) {
        const reference = [...readFileSync(javascript,'utf8').matchAll(/^\/\/[#@][ \t]*sourceMappingURL=([^\s]+)[ \t]*$/gm)].at(-1)?.[1];
        // Turbopack browser hashes differ; server entrypoints can have sibling
        // maps without a sourceMappingURL comment. Tie both to this exact JS.
        const map = reference ? sourceMapPath(reference,javascript,root) : kind === 'server' && mapSet.has(`${javascript}.map`) ? `${javascript}.map` : null;
        if (!map) continue;
        if (!mapSet.has(map)) throw new Error('Compiled JavaScript references a missing private source map.');
        const target = join(artifact,kind,relative(root,javascript));
        mkdirSync(resolve(target,'..'),{recursive:true}); copyFileSync(javascript,target);
        matched.add(map);
      }
      if (result.status === 0 && (!maps.length || !matched.size)) throw new Error(`No mapped ${kind} JavaScript generated.`);
      manifest.bundles.push({ kind, prefix, maps: maps.length, matched: matched.size });
    }
    mkdirSync(artifact,{recursive:true});
    manifest.files = files(artifact).map(file => ({ path: relative(artifact,file), sha256: digest(file) }));
    writeFileSync(join(artifact,'manifest.json'),JSON.stringify(manifest,null,2));
  } finally {
    // Strip both bundles even when build/copy fails; upload holds the private maps.
    for (const map of allMaps) unlinkSync(map);
  }
  if(result.status!==0)process.exit(result.status??1);
  console.log(`Private browser/server maps prepared for ${release}; upload and mapped-stack verification still required.`);
} else if (mode === 'upload') {
  if(!process.env.SENTRY_AUTH_TOKEN||!process.env.SENTRY_ORG||!process.env.SENTRY_PROJECT)throw new Error('SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT are required in this private CI step.');
  if(!existsSync(join(artifact,'manifest.json')))throw new Error('Build the exact release private artifacts first.');
  const manifest=JSON.parse(readFileSync(join(artifact,'manifest.json'),'utf8'));
  if(manifest.release!==release||manifest.buildSucceeded!==true||!Array.isArray(manifest.bundles)||!Array.isArray(manifest.files)||!manifest.files.length)throw new Error('Private artifact is not a successful exact-release build.');
  for(const file of manifest.files){
    const path=resolve(artifact,file.path);
    const bundle=bundles.find(item=>file.path.startsWith(`${item.kind}/`));
    if(!bundle||!path.startsWith(artifact+'/')||digest(path)!==file.sha256)throw new Error('Private source-map artifact integrity check failed.');
    const deployed=resolve(bundle.root,file.path.slice(bundle.kind.length+1));
    if(!deployed.startsWith(bundle.root+'/'))throw new Error('Invalid deployment artifact path.');
    if(file.path.endsWith('.js')&&digest(deployed)!==file.sha256)throw new Error('Deployment JavaScript differs from private source-map artifact.');
  }
  for(const bundle of bundles){
    if(files(bundle.root).some(file=>file.endsWith('.map')))throw new Error('Private source maps remain in deployment output.');
    const entry=manifest.bundles.find(item=>item.kind===bundle.kind);
    if(!entry?.maps||!entry.matched||entry.prefix!==bundle.prefix)throw new Error('Missing browser/server source-map manifest.');
  }
  // Validate every bundle before the first upload to prevent a partial stale release.
  for(const bundle of bundles){
    const result=spawnSync(process.env.SENTRY_CLI_PATH||resolve('node_modules/.bin/sentry-cli'),['sourcemaps','upload','--release',release,'--url-prefix',bundle.prefix,'--validate','--strict','--wait',join(artifact,bundle.kind)],{stdio:'inherit',env:process.env});
    if(result.error)throw result.error;
    if(result.status!==0)process.exit(result.status??1);
  }
  console.log(`Browser/server upload completed for ${release}. Mapped synthetic errors from this exact build are still required.`);
} else throw new Error('Usage: node scripts/diagnostics-source-maps.mjs build|upload');
