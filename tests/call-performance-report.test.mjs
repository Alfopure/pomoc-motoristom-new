import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLogExport, summarizePerformance } from '../scripts/lib/call-performance-report.mjs';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const row = (n,ms,status=200) => ({ scope:'request-performance', requestId:id(n), environment:'test', serverBuild:'dpl_test', operation:'call.hold', phase:'response', ms, status });
test('separates success, acceptance, failure and background; deduplicates exports and rejects negative clocks', () => {
  const report = summarizePerformance([row(1,100),row(1,100),row(2,9000,503),row(3,40,202),row(4,-5),{...row(5,50000),phase:'after'}, {...row(6,700),environment:'production'}]);
  const group = report.groups.find(x=>x.environment==='test');
  assert.deepEqual(group.outcomes,{ok:2,failed:1,accepted:1});
  assert.equal(group.invalidDuration,1);
  assert.equal(group.successful.meanMs,100); assert.equal(group.accepted.meanMs,40);
  assert.equal(group.observed.count,3); assert.equal(report.coverage.duplicates,1);
  assert.equal(report.coverage.invalidDuration,1); assert.equal(report.coverage.backgroundRecords,1);
  assert.equal(report.groups.length,2);
});
test('uses matched page/leg monotonic answer clocks; excludes human waiting and unmatched pairs', () => {
  const b=(n,phase,ms,extra={})=>({scope:'browser_call_timing',observationId:id(n),pageId:id(100),legId:id(101),environment:'development',appEnvironment:'test',serverBuild:'dpl_t',phase,browserMonotonicMs:ms,...extra});
  const report=summarizePerformance([b(1,'sdk_invite',10),b(2,'answer_requested',90010,{answerMode:'manual'}),b(3,'sdk_active',90496),b(4,'answer_requested',5,{legId:id(102)}),b(5,'sdk_active',10,{pageId:id(103),legId:id(102)})]);
  assert.equal(report.groups[0].successful.meanMs,486); assert.equal(report.groups[0].environment,'test');
  assert.equal(report.coverage.unmatchedAnswers,1);
});
test('reads supported exports without treating invalid/missing data as zeros', () => {
  assert.deepEqual(parseLogExport(JSON.stringify({content:[{type:'text',text:'### header\n    '+JSON.stringify(row(1,42))}]})),[row(1,42)]);
  assert.deepEqual(parseLogExport(JSON.stringify({message:JSON.stringify(row(2,50))})),[row(2,50)]);
  const report=summarizePerformance([row(1,null),row(2,NaN),{...row(3,1),requestId:null}]);
  assert.equal(report.groups.length,1); assert.equal(report.groups[0].observed.count,0);
  assert.equal(report.groups[0].observed.meanMs,null); assert.deepEqual(report.groups[0].outcomes,{ok:2});
  assert.equal(report.coverage.invalidDuration,2); assert.equal(report.coverage.missingIdentity,1);
});

test('missing clocks retain errors and cancellations without fabricating zero latency', () => {
  const report=summarizePerformance([row(1,100),{...row(2,null,503),dbAborts:1,steps:{db:{ms:42}}},row(3,-1,500),
    {scope:'call-request-performance',id:id(4),operation:'call.park',environment:'test',outcome:'cancelled',ms:null}]);
  const server=report.groups.find(x=>x.measurement==='handler_response');
  assert.deepEqual(server.outcomes,{ok:1,failed:2});
  assert.equal(server.successful.count,1); assert.equal(server.invalidDuration,2);
  assert.equal(server.observed.meanMs,100);
  assert.equal(server.databaseTimeouts,1); assert.equal(server.stages.db.meanMs,42);
  const browser=report.groups.find(x=>x.measurement==='request_roundtrip');
  assert.deepEqual(browser.outcomes,{cancelled:1}); assert.equal(browser.observed.count,0);
});

test('attributes queued requests to their responding build and keeps old tabs separate', () => {
  const b=(n,clientBuild,requestBuild)=>({scope:'call-request-performance',id:id(n),environment:'test',serverBuild:'telemetry_receiver_new',
    clientBuild,requestBuild,operation:'call.park',outcome:'ok',ms:12589.1});
  const report=summarizePerformance([b(1,'tab_old','request_old'),b(2,'tab_new','request_old'),b(3,undefined,undefined)]);
  assert.equal(report.groups.length,3);
  assert.deepEqual(report.groups.filter(x=>x.build==='request_old').map(x=>x.clientBuild).sort(),['tab_new','tab_old']);
  assert.ok(!report.groups.some(x=>x.build==='telemetry_receiver_new'));
  assert.equal(report.coverage.unknownRequestBuild,1);
});

test('pairs same-tab SDK clocks across telemetry receiver deployments without inventing an answer mode', () => {
  const b=(n,phase,t,serverBuild)=>({scope:'browser_call_timing',observationId:id(n),pageId:id(99),legId:id(98),
    appEnvironment:'test',environment:'development',serverBuild,clientBuild:'tab_old',phase,browserMonotonicMs:t});
  const report=summarizePerformance([b(1,'answer_requested',1000,'receiver_a'),b(2,'sdk_active',1486,'receiver_b')]);
  assert.equal(report.coverage.unmatchedAnswers,0); assert.equal(report.groups.length,1);
  assert.equal(report.groups[0].operation,'call.answer.unknown');
  assert.equal(report.groups[0].build,'tab_old'); assert.equal(report.groups[0].successful.meanMs,486);
});

test('repeated answer attempts never turn human retry waiting into successful answer latency', () => {
  const b=(n,phase,t,legId=id(98))=>({scope:'browser_call_timing',observationId:id(n),pageId:id(99),legId,
    appEnvironment:'test',serverBuild:'receiver',clientBuild:'client',phase,browserMonotonicMs:t,answerMode:'manual'});
  const report=summarizePerformance([b(1,'answer_requested',1000),b(2,'answer_requested',61000),b(3,'sdk_active',61500),
    b(4,'answer_requested',1000,id(97)),b(5,'sdk_ended',2000,id(97))]);
  assert.equal(report.groups.length,0); assert.equal(report.coverage.ambiguousAnswers,1);
  assert.equal(report.coverage.unmatchedAnswers,1); assert.equal(report.coverage.answersEndedWithoutActive,1);
});

test('preserves slow observations and reports timeout bounds separately from successful responses', () => {
  const b=(n,ms,outcome)=>({scope:'call-request-performance',id:id(n),environment:'test',clientBuild:'client',requestBuild:'request',operation:'call.park',ms,outcome});
  const group=summarizePerformance([b(1,100,'ok'),b(2,180001,'timeout'),b(3,120,'cancelled')]).groups[0];
  assert.equal(group.successful.meanMs,100); assert.equal(group.byOutcome.timeout.maxMs,180001);
  assert.equal(group.byOutcome.cancelled.count,1); assert.equal(group.observed.count,2);
});

test('legacy TEST phone-resource environment is not mistaken for application development', () => {
  const b=(n,phase,t)=>({scope:'browser_call_timing',observationId:id(n),pageId:id(99),legId:id(98),
    environment:'development',serverBuild:'receiver',phase,browserMonotonicMs:t,answerMode:'manual'});
  const group=summarizePerformance([b(1,'answer_requested',1000),b(2,'sdk_active',1486)]).groups[0];
  assert.equal(group.environment,'unknown'); assert.equal(group.build,'unknown');
});
