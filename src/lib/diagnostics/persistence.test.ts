import 'fake-indexeddb/auto';
import {describe,it,expect} from 'vitest';
import {createDiagnosticPersistence,type StoredDiagnostics} from './persistence';
const record:StoredDiagnostics={actor:{profileId:crypto.randomUUID(),organizationId:crypto.randomUUID()},events:[{id:crypto.randomUUID(),pageId:crypto.randomUUID(),sequence:1,occurredAt:new Date().toISOString(),monotonicMs:1,type:'user_report',module:'app',outcome:'unknown',buildId:'test',sampled:false,sampleRate:1}]};
describe('IndexedDB diagnostic persistence',()=>{
  it('survives recreation, isolates tabs and deletes logout data',async()=>{
    const tab=crypto.randomUUID();const first=createDiagnosticPersistence(tab);await first.write(record);
    expect(await createDiagnosticPersistence(tab).read()).toEqual(record);
    expect(await createDiagnosticPersistence(crypto.randomUUID()).read()).toBeNull();
    await first.write(null);expect(await first.read()).toBeNull();
  });
  it('cleans abandoned tab records after TTL',async()=>{
    const first=createDiagnosticPersistence(crypto.randomUUID());await first.write({...record,events:record.events.map(e=>({...e,occurredAt:new Date(Date.now()-86400001).toISOString()}))});
    expect(await first.read()).toBeNull();
  });
});
