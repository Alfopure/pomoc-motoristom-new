import { beginDiagnosticOperation, DiagnosticCollector, flushDiagnostics, getDiagnosticCoverage, recordDiagnostic, setDiagnosticIdentity } from '../../src/lib/diagnostics/client';
import { diagnosticJson } from '../../src/lib/diagnostics/request';
import '../../src/instrumentation-client';
const actor={profileId:'11111111-1111-4111-8111-111111111111',organizationId:'22222222-2222-4222-8222-222222222222'};
const opNames={save:'case.save',pickup:'call.pickup',hangup:'call.hangup'} as const;
const samples:number[]=[];
const attemptTimes:number[]=[];
const originalFetch=globalThis.fetch.bind(globalThis);
globalThis.fetch=(input,init)=>{if(input==='/api/diagnostics/events')attemptTimes.push(Date.now());return originalFetch(input,init);};
new PerformanceObserver(list=>{for(const e of list.getEntries())samples.push(e.duration);}).observe({type:'longtask',buffered:true});
Object.assign(window,{
 benchAttemptTimes(){return [...attemptTimes];},
 benchEnable(enabled:boolean){setDiagnosticIdentity(enabled?actor:null);},
 async benchOperations(operation:keyof typeof opNames,enabled:boolean,n:number){
  const timings:number[]=[];
  for(let i=0;i<n;i++){
   const start=performance.now();
   if(enabled)await diagnosticJson(opNames[operation],operation==='save'?'cases':'telephony',`/fixture/${operation}`,{method:'POST'});
   else {const response=await fetch(`/fixture/${operation}`,{method:'POST'});await response.json();}
   timings.push(performance.now()-start);
  }
  return {timings,coverage:getDiagnosticCoverage(),longTasks:samples.splice(0)};
 },
 benchEnqueue(n:number){const c=new DiagnosticCollector({pageId:crypto.randomUUID(),buildId:'fixture',persistence:{read:async()=>null,write:async()=>{}},online:()=>false});c.setIdentity(actor);const timings:number[]=[];for(let i=0;i<n;i++){const start=performance.now();c.record({type:'operation',operation:'case.save',module:'cases',outcome:'ok',sampled:true,sampleRate:.05});timings.push(performance.now()-start);}return {timings,coverage:c.coverage()};},
 benchErrors(n:number){for(let i=0;i<n;i++)recordDiagnostic({type:'ui_error',module:'app',outcome:'failed',errorClass:'TypeError',errorId:'storm_fixture'});return getDiagnosticCoverage();},
 benchHealthyOperation(){const finish=beginDiagnosticOperation('case.save','cases');finish({outcome:'ok',durationMs:25});},
 benchFlush:flushDiagnostics,
 benchCoverage:getDiagnosticCoverage,
});
