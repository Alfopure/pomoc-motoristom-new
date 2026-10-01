import {afterEach,describe,it,expect,vi} from 'vitest';
import {getDiagnosticCallContext,setDiagnosticCallContext,retainDiagnosticCallContext} from './context';
import {DiagnosticCollector} from './client';
const callSessionId='11111111-1111-4111-8111-111111111111';const deviceSessionId='22222222-2222-4222-8222-222222222222';
afterEach(()=>{setDiagnosticCallContext(null);vi.restoreAllMocks();});
describe('crash call evidence context',()=>{
 it('allows UUIDs only and returns a copy',()=>{setDiagnosticCallContext({callSessionId,deviceSessionId:'CANARY'});const context=getDiagnosticCallContext();expect(context).toEqual({callSessionId});context.callSessionId='mutated';expect(getDiagnosticCallContext()).toEqual({callSessionId});});
 it('retains unmount evidence for only five seconds, never infers cause',()=>{const now=vi.spyOn(performance,'now').mockReturnValue(10);setDiagnosticCallContext({callSessionId,deviceSessionId});retainDiagnosticCallContext('component_unmount');expect(getDiagnosticCallContext()).toEqual({callSessionId,deviceSessionId});now.mockReturnValue(5010);expect(getDiagnosticCallContext()).toEqual({});});
 it('normal hangup, next call and identity changes discard old context',()=>{setDiagnosticCallContext({callSessionId});retainDiagnosticCallContext('hangup_intent');expect(getDiagnosticCallContext()).toEqual({});setDiagnosticCallContext({callSessionId});retainDiagnosticCallContext('component_unmount');setDiagnosticCallContext({deviceSessionId});expect(getDiagnosticCallContext()).toEqual({deviceSessionId});const c=new DiagnosticCollector({pageId:callSessionId,buildId:'test',persistence:{read:async()=>null,write:async()=>{}}});c.setIdentity({profileId:callSessionId,organizationId:deviceSessionId});expect(getDiagnosticCallContext()).toEqual({});});
});
