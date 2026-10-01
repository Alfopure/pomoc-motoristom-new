import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, copyFileSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
const mode = process.argv[2];
const release = process.env.DEPLOYMENT_VERSION || process.env.VERCEL_GIT_COMMIT_SHA;
if (!release || !/^[a-zA-Z0-9_-]{1,64}$/.test(release)) throw new Error('Set the exact immutable DEPLOYMENT_VERSION (safe release ID, max 64 characters).');
const artifact = resolve('.context/diagnostics-source-maps', release);
function files(directory) { return existsSync(directory) ? readdirSync(directory,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(directory,e.name)):[join(directory,e.name)]) : []; }
if (mode === 'build') {
  const result = spawnSync('pnpm',['build'],{stdio:'inherit',env:{...process.env,DIAGNOSTICS_PRIVATE_SOURCE_MAPS:'1'}});
  const root = resolve('.next/static');
  const maps = files(root).filter(f=>f.endsWith('.map'));
  try {
    for (const map of maps) {
      const target = join(artifact,relative(root,map)); mkdirSync(resolve(target,'..'),{recursive:true}); copyFileSync(map,target);
      const javascript = map.slice(0,-4); if(existsSync(javascript))copyFileSync(javascript,target.slice(0,-4));
    }
    mkdirSync(artifact,{recursive:true});writeFileSync(join(artifact,'manifest.json'),JSON.stringify({release,maps:maps.length,buildSucceeded:result.status===0,uploaded:false},null,2));
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
  const result=spawnSync(process.env.SENTRY_CLI_PATH||'sentry-cli',['sourcemaps','upload','--release',release,'--url-prefix','~/_next/static','--validate',artifact],{stdio:'inherit',env:process.env});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
  console.log(`Upload completed for ${release}. A mapped synthetic error from this exact build is still required.`);
} else throw new Error('Usage: node scripts/diagnostics-source-maps.mjs build|upload');
