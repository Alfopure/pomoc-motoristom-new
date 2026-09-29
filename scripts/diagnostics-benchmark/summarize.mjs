import {readFileSync,writeFileSync} from 'node:fs';
const d=JSON.parse(readFileSync('.context/ralph-monitor/performance/browser-results.json','utf8'));
const percentile=(v,q)=>{const s=[...v].sort((a,b)=>a-b);return s[Math.ceil(q*s.length)-1];};
let seed=1729;const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
const sample=v=>Array.from({length:v.length},()=>v[Math.floor(random()*v.length)]);
const operations=[];
for(const operation of ['save','pickup','hangup']){
 const off=d.runs.filter(r=>r.operation===operation&&!r.enabled),on=d.runs.filter(r=>r.operation===operation&&r.enabled);
 const a=off.flatMap(r=>r.timings),b=on.flatMap(r=>r.timings);const p95Off=percentile(a,.95),p95On=percentile(b,.95);const differences=[];
 for(let i=0;i<2000;i++)differences.push(percentile(on.flatMap(r=>sample(r.timings)),.95)-percentile(off.flatMap(r=>sample(r.timings)),.95));
 const upper95Ms=percentile(differences,.975),thresholdMs=Math.max(.02*p95Off,5);
 operations.push({operation,nOff:a.length,nOn:b.length,p95OffMs:p95Off,p95OnMs:p95OnMsFix(p95On),deltaMs:p95On-p95Off,bootstrap95:{lowerMs:percentile(differences,.025),upperMs:upper95Ms,iterations:2000,stratifiedByCycle:true},thresholdMs,fixturePass:upper95Ms<=thresholdMs});
}
function p95OnMsFix(v){return v;}
const totals=requests=>({requests:requests.length,postBodyBytes:requests.reduce((s,r)=>s+r.bytes,0),conservativeBytesIncluding2KiBOverheadPerRequest:requests.reduce((s,r)=>s+r.bytes+2048,0),maxEventsPerBatch:Math.max(0,...requests.map(r=>r.events)),maxBatchBytes:Math.max(0,...requests.map(r=>r.bytes))});
const byPage={};for(const request of d.storm.requests)for(const id of request.pageIds)byPage[id]=(byPage[id]??0)+1;
const rollingAttempts=(d.storm.attemptTimes??[]).map(times=>Math.max(0,...times.map(end=>times.filter(t=>t>end-60000&&t<=end).length)));
const out={at:d.at,browser:d.browser,fixture:d.fixture,usability:d.usability,operations,enqueue:{n:d.enqueue.timings.length,p95Ms:percentile(d.enqueue.timings,.95),maxMs:Math.max(...d.enqueue.timings),coverage:d.enqueue.coverage},longTasksDuringOperations:d.runs.flatMap(r=>r.longTasks),storm:{...totals(d.storm.requests),virtualSeconds:d.storm.virtualSeconds,tabs:d.storm.tabs,errorsPerTab:d.storm.errorsPerTab,requestsPerPage:byPage,maxAttemptsPerSlidingMinuteByTab:rollingAttempts,coverage:d.storm.coverage},healthy:{...totals(d.healthy.requests),virtualHours:8,heapBefore:d.healthy.heapBefore,heapAfter:d.healthy.heapAfter,operations:d.healthy.operations,coverage:d.healthy.coverage},limits:['Mock business endpoints on localhost; no live calls, DB, audio, SMS or providers.','Virtual time accelerates storm/8h session; this does not measure an eight-hour memory leak.','Sentry DSN disabled: real SDK upload traffic and mapped source stack remain unverified.','Network byte totals include exact POST body plus conservative 2KiB/request overhead, not a packet capture.','No hosted TEST network/DB/load benchmark; these results do not satisfy the full deployment performance gate.']};writeFileSync('.context/ralph-monitor/performance/summary.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out,null,2));
