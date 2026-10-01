import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, copyFileSync, unlinkSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
const mode = process.argv[2];
const release = process.env.DEPLOYMENT_VERSION || process.env.VERCEL_GIT_COMMIT_SHA;
if (!release || !/^[a-zA-Z0-9_-]{1,64}$/.test(release)) throw new Error('Set the exact immutable DEPLOYMENT_VERSION (safe release ID, max 64 characters).');
const artifact = resolve('.context/diagnostics-source-maps', release);
function files(directory) { return existsSync(directory) ? readdirSync(directory,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(directory,e.name)):[join(directory,e.name)]) : []; }
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
if (mode === 'build') {
  // A retry of the same release must never upload stale artifacts from a prior build.
  rmSync(artifact, { recursive: true, force: true });
  const result = spawnSync('pnpm',['build'],{stdio:'inherit',env:{...process.env,DIAGNOSTICS_PRIVATE_SOURCE_MAPS:'1',SENTRY_AUTH_TOKEN:undefined}});
  const root = resolve('.next/static');
  const maps = files(root).filter(f=>f.endsWith('.map'));
  try {
    for (const map of maps) {
      const target = join(artifact,relative(root,map)); mkdirSync(resolve(target,'..'),{recursive:true}); copyFileSync(map,target);
      const javascript = map.slice(0,-4);
      if(!existsSync(javascript))throw new Error('Source map has no matching compiled JavaScript.');
      copyFileSync(javascript,target.slice(0,-4));
    }
    mkdirSync(artifact,{recursive:true});writeFileSync(join(artifact,'manifest.json'),JSON.stringify({release,maps:maps.length,buildSucceeded:result.status===0,files:files(artifact).map(file=>({path:relative(artifact,file),sha256:digest(file)}))},null,2));
  } finally {
    // Even a failed artifact copy must not leave public source maps in deployment output.
    for (const map of maps) unlinkSync(map);
  }
  if(result.status!==0)process.exit(result.status??1);
  if(!maps.length)throw new Error('No source maps generated; mapping verification remains blocked.');
  console.log(`Private source maps prepared for ${release}: ${maps.length}; upload and mapped-stack verification still required.`);
} else if (mode === 'upload') {
  if(!process.env.SENTRY_AUTH_TOKEN||!process.env.SENTRY_ORG||!process.env.SENTRY_PROJECT)throw new Error('SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT are required in this private CI step.');
  if(!existsSync(join(artifact,'manifest.json')))throw new Error('Build the exact release private artifacts first.');
  const manifest=JSON.parse(readFileSync(join(artifact,'manifest.json'),'utf8'));
  if(manifest.release!==release||manifest.buildSucceeded!==true||!manifest.maps||!Array.isArray(manifest.files)||!manifest.files.length)throw new Error('Private artifact is not a successful exact-release build.');
  for(const file of manifest.files){
    const path=resolve(artifact,file.path);
    if(!path.startsWith(artifact+'/')||digest(path)!==file.sha256)throw new Error('Private source-map artifact integrity check failed.');
    if(file.path.endsWith('.js')&&digest(resolve('.next/static',file.path))!==file.sha256)throw new Error('Deployment JavaScript differs from private source-map artifact.');
  }
  if(files(resolve('.next/static')).some(file=>file.endsWith('.map')))throw new Error('Public source maps remain in deployment output.');
  const result=spawnSync(process.env.SENTRY_CLI_PATH||resolve('node_modules/.bin/sentry-cli'),['sourcemaps','upload','--release',release,'--url-prefix','~/_next/static','--validate','--strict','--wait',artifact],{stdio:'inherit',env:process.env});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
  console.log(`Upload completed for ${release}. A mapped synthetic error from this exact build is still required.`);
} else throw new Error('Usage: node scripts/diagnostics-source-maps.mjs build|upload');
