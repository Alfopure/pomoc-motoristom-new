import {afterEach,describe,it,expect,vi} from 'vitest';
vi.mock('./client',()=>({recordDiagnostic:vi.fn(()=>crypto.randomUUID())}));
vi.mock('./sentry',()=>({diagnosticErrorClass:()=> 'TypeError',sanitizeDiagnosticException:()=>null,sendDiagnosticException:vi.fn()}));
import {recordDiagnostic} from './client';
import {captureDiagnosticError} from './errors';
import {retainDiagnosticCallContext,setDiagnosticCallContext} from './context';
afterEach(()=>{setDiagnosticCallContext(null);vi.clearAllMocks();});
describe('error to call correlation',()=>{
 it('carries the explicit last unmount context into the boundary event',()=>{const callSessionId=crypto.randomUUID(),deviceSessionId=crypto.randomUUID();setDiagnosticCallContext({callSessionId,deviceSessionId});retainDiagnosticCallContext('component_unmount');captureDiagnosticError(new TypeError('CANARY'),'ui_error',true);expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({callSessionId,deviceSessionId,reason:'boundary'}));expect(JSON.stringify(vi.mocked(recordDiagnostic).mock.calls)).not.toContain('CANARY');});
 it('never attaches a normally cleared call to a later unrelated crash',()=>{setDiagnosticCallContext({callSessionId:crypto.randomUUID()});setDiagnosticCallContext(null);captureDiagnosticError(new TypeError('later'),'ui_error',true);expect(vi.mocked(recordDiagnostic).mock.calls[0][0]).not.toHaveProperty('callSessionId');});
});
