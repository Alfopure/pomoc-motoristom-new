import { DIAGNOSTIC_MODULES, DIAGNOSTIC_OPERATIONS, DIAGNOSTIC_OUTCOMES, isDiagnosticUuid } from './types';

const screens = ['dispatch', 'tasks', 'notes', 'tools', 'cases', 'call-center', 'attendance', 'fleet', 'reports', 'settings'] as const;
const savePhases = ['idle', 'waiting', 'saving', 'saved', 'error'] as const;
export type DiagnosticUiContext = {
  state_origin: 'last_committed';
  screen?: typeof screens[number];
  case_id?: string;
  workspace_kind?: 'cockpit' | 'detail' | 'new';
  workspace_mode?: 'collapsed' | 'split' | 'expanded';
  editor_revision?: number;
  dirty?: boolean;
  save_phase?: typeof savePhases[number];
  conflict?: boolean;
  replacement_only?: boolean;
  collaboration_available?: boolean;
  collaboration_hidden?: boolean;
  collaboration_connected?: boolean;
  collaboration_stale?: boolean;
};
export type DiagnosticBreadcrumb = {
  timestamp: number;
  category: 'diagnostic.operation';
  type: 'default';
  level: 'info';
  data: { module: typeof DIAGNOSTIC_MODULES[number]; operation: typeof DIAGNOSTIC_OPERATIONS[number]; phase: 'start' | 'finish'; outcome?: typeof DIAGNOSTIC_OUTCOMES[number]; case_id?: string; duration_ms?: number };
};
const member = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && values.includes(value as T);
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Closed fields only: no input values, names, URLs, messages or arbitrary metadata. */
export function sanitizeDiagnosticUiContext(value: unknown): DiagnosticUiContext {
  const input = object(value);
  const safe: DiagnosticUiContext = { state_origin: 'last_committed' };
  if (member(screens, input.screen)) safe.screen = input.screen;
  if (isDiagnosticUuid(input.case_id)) safe.case_id = input.case_id;
  if (member(['cockpit', 'detail', 'new'] as const, input.workspace_kind)) safe.workspace_kind = input.workspace_kind;
  if (member(['collapsed', 'split', 'expanded'] as const, input.workspace_mode)) safe.workspace_mode = input.workspace_mode;
  if (typeof input.editor_revision === 'number' && Number.isInteger(input.editor_revision) && input.editor_revision >= 0 && input.editor_revision <= 2_147_483_647) safe.editor_revision = input.editor_revision;
  if (member(savePhases, input.save_phase)) safe.save_phase = input.save_phase;
  for (const key of ['dirty', 'conflict', 'replacement_only', 'collaboration_available', 'collaboration_hidden', 'collaboration_connected', 'collaboration_stale'] as const) {
    if (typeof input[key] === 'boolean') safe[key] = input[key];
  }
  return safe;
}

export function sanitizeDiagnosticBreadcrumbs(value: unknown): DiagnosticBreadcrumb[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-12).flatMap(raw => {
    const item = object(raw), data = object(item.data);
    if (item.category !== 'diagnostic.operation' || typeof item.timestamp !== 'number' || !Number.isFinite(item.timestamp) || item.timestamp < 0 || item.timestamp > 10_000_000_000 ||
      !member(DIAGNOSTIC_MODULES, data.module) || !member(DIAGNOSTIC_OPERATIONS, data.operation) || !member(['start', 'finish'] as const, data.phase)) return [];
    const safe: DiagnosticBreadcrumb = { timestamp: item.timestamp, category: 'diagnostic.operation', type: 'default', level: 'info', data: { module: data.module, operation: data.operation, phase: data.phase } };
    if (member(DIAGNOSTIC_OUTCOMES, data.outcome)) safe.data.outcome = data.outcome;
    if (isDiagnosticUuid(data.case_id)) safe.data.case_id = data.case_id;
    if (typeof data.duration_ms === 'number' && Number.isFinite(data.duration_ms) && data.duration_ms >= 0 && data.duration_ms <= 86_400_000) safe.data.duration_ms = Math.round(data.duration_ms);
    return [safe];
  });
}

let workspace: DiagnosticUiContext | null = null;
let editor: DiagnosticUiContext | null = null;
let workspaceExpires = Infinity, editorExpires = Infinity;
let operations: DiagnosticBreadcrumb[] = [];
export function setDiagnosticWorkspaceContext(value: Partial<DiagnosticUiContext>) {
  try { workspace = sanitizeDiagnosticUiContext(value); workspaceExpires = Infinity; } catch { workspace = null; }
}
export function setDiagnosticEditorContext(value: Partial<DiagnosticUiContext>) {
  try { editor = sanitizeDiagnosticUiContext(value); editorExpires = Infinity; } catch { editor = null; }
}
/** Boundaries run after cleanup; retain the last committed state for at most 5s. */
export function retainDiagnosticUiContext(kind: 'workspace' | 'editor', caseId?: string) {
  try {
    if (kind === 'workspace') workspaceExpires = performance.now() + 5000;
    else if (editor?.case_id === caseId) editorExpires = performance.now() + 5000;
  } catch { resetDiagnosticUiContext(); }
}
export function getDiagnosticUiContext(): DiagnosticUiContext {
  try {
    const now = performance.now();
    if (now >= workspaceExpires) workspace = null;
    if (now >= editorExpires) editor = null;
    const matched = editor && (!workspace || editor.case_id === workspace.case_id);
    return sanitizeDiagnosticUiContext({ ...workspace, ...(matched ? editor : {}) });
  } catch { return { state_origin: 'last_committed' }; }
}
export function addDiagnosticBreadcrumb(value: DiagnosticBreadcrumb) {
  try { operations = sanitizeDiagnosticBreadcrumbs([...operations, value]); } catch { /* No diagnostic failure may affect an action. */ }
}
export function getDiagnosticBreadcrumbs() { return sanitizeDiagnosticBreadcrumbs(operations); }
export function resetDiagnosticUiContext() { workspace = editor = null; operations = []; workspaceExpires = editorExpires = Infinity; }
