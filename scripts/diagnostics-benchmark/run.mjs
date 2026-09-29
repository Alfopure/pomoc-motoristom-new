import {createServer} from 'node:http';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright-core';
import {build} from 'esbuild';
mkdirSync('.context/ralph-monitor/performance',{recursive:true});
await build({entryPoints:['e2e/fixtures/diagnostics-benchmark.ts'],bundle:true,minify:true,format:'iife',platform:'browser',outfile:'.context/ralph-monitor/performance/fixture.js',define:{'process.env.NODE_ENV':'"production"','process.env.NEXT_PUBLIC_DIAGNOSTICS_BUILD_ID':'"benchmark_fixture"','process.env.NEXT_PUBLIC_DIAGNOSTICS_SENTRY_DSN':'""'}});
const requests=[];
const server=createServer(async(req,res)=>{
 if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(readFileSync('.context/ralph-monitor/performance/fixture.js'));return;}
 if(req.url.startsWith('/fixture/')){res.setHeader('content-type','application/json');res.setHeader('x-request-id','33333333-3333-4333-8333-333333333333');setTimeout(()=>res.end('{"ok":true}'),2);return;}
 if(req.url==='/api/diagnostics/events'){const chunks=[];for await(const chunk of req)chunks.push(chunk);const text=Buffer.concat(chunks).toString();const body=JSON.parse(text);requests.push({at:Date.now(),bytes:Buffer.byteLength(text),events:body.events.length,pageIds:[...new Set(body.events.map(e=>e.pageId))]});res.setHeader('content-type','application/json');res.end(JSON.stringify({acceptedIds:body.events.map(e=>e.id)}));return;}
 res.setHeader('content-type','text/html');res.end('<!doctype html><html><body><button id="test">Run save fixture</button><p id="result">Ready</p><script src="/fixture.js"></script><script>document.querySelector("#test").onclick=async()=>{await benchOperations("save",true,1);document.querySelector("#result").textContent="Saved fixture"}</script></body></html>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext();const page=await context.newPage();await page.goto(url);await page.evaluate(()=>benchEnable(true));await page.click('#test');await page.waitForFunction(()=>document.querySelector('#result').textContent==='Saved fixture');
const output={at:new Date().toISOString(),browser:browser.version(),hardware:{node:process.version},fixture:{responseDelayMs:2,network:'localhost HTTP',business:'mock responses, no DB/provider/audio',sentryConfigured:false},usability:'fixture button completed save',runs:[],network:requests};
if(process.argv.includes('--load-only'))output.runs=JSON.parse(readFileSync('.context/ralph-monitor/performance/browser-results.json','utf8')).runs;
for(let cycle=0;cycle<(process.argv.includes('--load-only')?0:3);cycle++)for(const enabled of [false,true]){
 await page.evaluate(e=>benchEnable(e),enabled);
 for(const operation of ['save','pickup','hangup']){
  await page.evaluate(({operation,enabled})=>benchOperations(operation,enabled,100),{operation,enabled});
  const result=await page.evaluate(({operation,enabled})=>benchOperations(operation,enabled,500),{operation,enabled});
  output.runs.push({cycle,enabled,operation,...result});console.log(`cycle=${cycle+1} mode=${enabled?'ON':'OFF'} ${operation} n=500`);
 }
}
output.enqueue=await page.evaluate(()=>benchEnqueue(10000));
await context.close();
const stormContext=await browser.newContext();const tabs=await Promise.all(Array.from({length:10},()=>stormContext.newPage()));
await Promise.all(tabs.map(p=>p.goto(url)));await tabs[0].clock.install({time:new Date('2026-09-29T12:00:00Z')});await tabs[0].clock.pauseAt(new Date('2026-09-29T12:00:01Z'));await Promise.all(tabs.map(p=>p.evaluate(()=>benchEnable(true))));
const before=requests.length;const stormStart=await tabs[0].evaluate(()=>Date.now());
for(let second=0;second<60;second++){
 await Promise.all(tabs.map(p=>p.evaluate(n=>benchErrors(n),second<40?17:16)));
 await tabs[0].clock.fastForward(1000);
}
await Promise.all(tabs.map(p=>p.evaluate(()=>benchFlush())));
output.storm={tabs:10,errorsPerTab:1000,attemptTimes:await Promise.all(tabs.map(p=>p.evaluate(()=>benchAttemptTimes()))),virtualSeconds:(await tabs[0].evaluate(()=>Date.now())-stormStart)/1000,coverage:await Promise.all(tabs.map(p=>p.evaluate(()=>benchCoverage()))),requests:requests.slice(before)};
await stormContext.close();
// Accelerated eight-hour healthy session, one explicit sampled operation per minute.
const healthy=await browser.newContext();const healthyPage=await healthy.newPage();await healthyPage.goto(url);await healthyPage.clock.install({time:new Date('2026-09-29T00:00:00Z')});await healthyPage.clock.pauseAt(new Date('2026-09-29T00:00:01Z'));await healthyPage.evaluate(()=>benchEnable(true));const hstart=requests.length;const healthyCdp=await healthy.newCDPSession(healthyPage);await healthyCdp.send('HeapProfiler.collectGarbage');const heapBefore=await healthyCdp.send('Runtime.getHeapUsage');
for(let minute=0;minute<480;minute++){await healthyPage.evaluate(()=>benchHealthyOperation());await healthyPage.clock.fastForward(60_000);await healthyPage.evaluate(()=>benchFlush());}
await healthyCdp.send('HeapProfiler.collectGarbage');const heapAfter=await healthyCdp.send('Runtime.getHeapUsage');
output.healthy={heapBefore,heapAfter,virtualHours:8,operations:480,requests:requests.slice(hstart),coverage:await healthyPage.evaluate(()=>benchCoverage())};
await healthy.close();await browser.close();server.close();writeFileSync('.context/ralph-monitor/performance/browser-results.json',JSON.stringify(output,null,2));console.log('Wrote browser-results.json');
