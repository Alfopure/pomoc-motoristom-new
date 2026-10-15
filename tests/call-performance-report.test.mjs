import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLogExport, summarizePerformance } from '../scripts/lib/call-performance-report.mjs';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const row = (n,ms,status=200) => ({ scope:'request-performance', requestId:id(n), environment:'test', serverBuild:'dpl_test', operation:'call.hold', phase:'response', ms, status });
test('separates success, acceptance, failure and background; deduplicates exports and rejects negative clocks', () => {
  const report = summarizePerformance([row(1,100),row(1,100),row(2,9000,503),row(3,40,202),row(4,-5),{...row(5,50000),phase:'after'}, {...row(6,700),environment:'production'}]);
  const group = report.groups.find(x=>x.environment==='test');
  assert.deepEqual(group.outcomes,{ok:1,failed:1,accepted:1});
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
  assert.equal(report.groups.length,0); assert.equal(report.coverage.invalidDuration,2); assert.equal(report.coverage.missingIdentity,1);
});
