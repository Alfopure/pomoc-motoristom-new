import {afterEach,describe,it,expect,vi} from 'vitest';
vi.mock('./client',()=>({recordDiagnostic:vi.fn(()=>crypto.randomUUID()),getDiagnosticPageId:()=> '11111111-1111-4111-8111-111111111111'}));
vi.mock('./sentry',()=>({diagnosticErrorClass:()=> 'TypeError',sanitizeDiagnosticException:()=>null,sendDiagnosticException:vi.fn()}));
import {recordDiagnostic} from './client';
import {captureDiagnosticError} from './errors';
import {retainDiagnosticCallContext,setDiagnosticCallContext} from './context';
import { resetDiagnosticUiContext, retainDiagnosticUiContext, setDiagnosticEditorContext } from './ui-context';
afterEach(()=>{setDiagnosticCallContext(null);resetDiagnosticUiContext();vi.clearAllMocks();});
describe('error to call correlation',()=>{
 it('keeps the last committed case in the internal boundary event',()=>{const caseId=crypto.randomUUID();setDiagnosticEditorContext({case_id:caseId,dirty:true});retainDiagnosticUiContext('editor',caseId);captureDiagnosticError(new TypeError('CANARY'),'ui_error',true);expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({caseId,reason:'boundary'}));});
 it('carries the explicit last unmount context into the boundary event',()=>{const callSessionId=crypto.randomUUID(),deviceSessionId=crypto.randomUUID();setDiagnosticCallContext({callSessionId,deviceSessionId});retainDiagnosticCallContext('component_unmount');captureDiagnosticError(new TypeError('CANARY'),'ui_error',true);expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({callSessionId,deviceSessionId,reason:'boundary'}));expect(JSON.stringify(vi.mocked(recordDiagnostic).mock.calls)).not.toContain('CANARY');});
 it('never attaches a normally cleared call to a later unrelated crash',()=>{setDiagnosticCallContext({callSessionId:crypto.randomUUID()});setDiagnosticCallContext(null);captureDiagnosticError(new TypeError('later'),'ui_error',true);expect(vi.mocked(recordDiagnostic).mock.calls[0][0]).not.toHaveProperty('callSessionId');});
});
