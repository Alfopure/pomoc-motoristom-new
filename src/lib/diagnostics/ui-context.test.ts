import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDiagnosticBreadcrumb, getDiagnosticBreadcrumbs, getDiagnosticUiContext, resetDiagnosticUiContext, retainDiagnosticUiContext, sanitizeDiagnosticUiContext, setDiagnosticEditorContext, setDiagnosticWorkspaceContext } from './ui-context';
const caseId = '11111111-1111-4111-8111-111111111111';
afterEach(() => { resetDiagnosticUiContext(); vi.restoreAllMocks(); });
describe('closed UI context', () => {
  it('retains a committed editor through cleanup and expires it after the boundary window', () => {
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    setDiagnosticWorkspaceContext({ screen: 'dispatch', case_id: caseId, workspace_kind: 'detail', workspace_mode: 'expanded' });
    setDiagnosticEditorContext({ case_id: caseId, dirty: true, save_phase: 'waiting', conflict: false });
    retainDiagnosticUiContext('editor', caseId); retainDiagnosticUiContext('workspace');
    expect(getDiagnosticUiContext()).toMatchObject({ case_id: caseId, dirty: true, save_phase: 'waiting' });
    now += 5001;
    expect(getDiagnosticUiContext()).toEqual({ state_origin: 'last_committed' });
  });
  it('does not attach another case editor state after navigation', () => {
    setDiagnosticEditorContext({ case_id: caseId, dirty: true });
    setDiagnosticWorkspaceContext({ case_id: '22222222-2222-4222-8222-222222222222', screen: 'dispatch' });
    expect(getDiagnosticUiContext()).not.toHaveProperty('dirty');
  });
  it('drops arbitrary text and invalid field types', () => {
    const context = sanitizeDiagnosticUiContext({ screen: 'CANARY', case_id: 'CANARY', dirty: 'CANARY', save_phase: 'CANARY', editor_revision: Infinity, draft: 'CANARY', workspace_kind: 'detail' });
    expect(context).toEqual({ state_origin: 'last_committed', workspace_kind: 'detail' });
  });
  it('keeps only twelve bounded operations, and clears them with the actor', () => {
    for (let i = 0; i < 50; i++) addDiagnosticBreadcrumb({ timestamp: i, category: 'diagnostic.operation', type: 'default', level: 'info', data: { module: 'cases', operation: 'case.save', phase: 'start', case_id: caseId } });
    expect(getDiagnosticBreadcrumbs()).toHaveLength(12);
    expect(getDiagnosticBreadcrumbs()[0].timestamp).toBe(38);
    resetDiagnosticUiContext();
    expect(getDiagnosticBreadcrumbs()).toEqual([]);
  });
});
