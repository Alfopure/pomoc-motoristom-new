import type { MobileHandoffInput, MobileHandoffMutation } from '../../../src/lib/mobile-api';
import { draftDate, draftId, draftKeys, draftObject, draftText, type DraftPort } from '../drafts/port';
import type { HandoffState } from './draft';
import { parseSnapshot } from './api';
const requireDraft = (ok: unknown) => { if (!ok) throw new Error('Invalid handoff draft'); };
const revision = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= 2147483647;
const version = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const validText = (v: unknown, max: number): v is string => draftText(v, max) && !Array.from(v).some(char => { const code = char.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; });
const utc = (v: unknown): v is string => draftDate(v) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && new Date(v).toISOString() === v;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
export function handoffCommand(value: unknown): Exclude<MobileHandoffInput, { action: 'recover' }> {
  const v = draftObject(value), action = v.action;
  requireDraft(['issue', 'publish', 'renew', 'extend', 'revoke'].includes(action as string) && draftId(v.commandId));
  const target = action === 'issue' ? [] : ['handoffId', 'expectedRevision'];
  const fields = action === 'issue' ? ['recipientName', 'recipientPhone', 'previewVersion', 'instructions', 'scheduledAt', 'hours']
    : action === 'publish' ? ['previewVersion', 'instructions', 'scheduledAt'] : action === 'revoke' ? ['comment'] : ['hours'];
  draftKeys(v, ['action', 'commandId', ...target, ...fields]);
  if (action !== 'issue') requireDraft(draftId(v.handoffId) && revision(v.expectedRevision));
  if (action === 'issue' || action === 'publish') requireDraft(version(v.previewVersion) && validText(v.instructions, 2000) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v.instructions) && (v.scheduledAt === null || utc(v.scheduledAt)));
  if (action === 'issue') requireDraft(validText(v.recipientName, 160) && !!v.recipientName.trim() && !/[\x00-\x1f\x7f]/.test(v.recipientName) && typeof v.recipientPhone === 'string' && /^\+?[\d ()-]{5,30}$/.test(v.recipientPhone));
  if (action === 'issue' || action === 'renew' || action === 'extend') requireDraft(typeof v.hours === 'number' && Number.isInteger(v.hours) && v.hours >= 1 && v.hours <= 72);
  if (action === 'revoke') requireDraft(validText(v.comment, 1000) && !!v.comment.trim() && !/[\x00-\x1f\x7f]/.test(v.comment));
  return clone(v) as Exclude<MobileHandoffInput, { action: 'recover' }>;
}
function receipt(value: unknown, pending: ReturnType<typeof handoffCommand>, caseId: string, port: DraftPort): MobileHandoffMutation {
  const v = draftObject(value);
  draftKeys(v, ['ok', 'apiVersion', 'environment', 'profileId', 'checkedAt', 'kind', 'caseId', 'handoffId', 'commandId', 'action', 'committedRevision', 'currentRevision', 'refreshRequired', 'link']);
  requireDraft(port.acceptsScope(v) && v.kind === 'mutation' && v.caseId === caseId && draftId(v.handoffId) && v.commandId === pending.commandId && v.action === pending.action && v.refreshRequired === true);
  const expected = pending.action === 'issue' ? 1 : pending.expectedRevision + 1;
  requireDraft(v.committedRevision === expected && revision(v.currentRevision) && v.currentRevision >= expected && (pending.action === 'issue' || v.handoffId === pending.handoffId));
  const link = draftObject(v.link); draftKeys(link, ['status'], link.status === 'unavailable' ? ['warning'] : []);
  requireDraft(link.status === 'not_requested' || link.status === 'unavailable' && link.warning === 'link_unavailable');
  return clone(v) as MobileHandoffMutation;
}
export function handoffProjection(caseId: string, state: HandoffState) {
  const safeReceipt = state.receipt ? { ...state.receipt, link: state.receipt.link.status === 'unavailable' ? { status: 'unavailable', warning: 'link_unavailable' } : { status: 'not_requested' } } : null;
  return clone({ version: 1, caseId, input: state.input, selected: state.selected, status: state.status, pending: state.pending, receipt: safeReceipt });
}
export function restoreHandoff(value: unknown, caseId: string, port: DraftPort): Pick<HandoffState, 'input' | 'selected' | 'status' | 'pending' | 'receipt'> {
  const v = draftObject(value); draftKeys(v, ['version', 'caseId', 'input', 'selected', 'status', 'pending', 'receipt']);
  requireDraft(v.version === 1 && v.caseId === caseId && ['editing', 'saving', 'uncertain', 'conflict', 'saved'].includes(v.status as string));
  const input = draftObject(v.input); draftKeys(input, ['recipientName', 'recipientPhone', 'instructions', 'scheduledAt', 'hours', 'comment']);
  for (const [key, max] of [['recipientName', 160], ['recipientPhone', 30], ['instructions', 2000], ['scheduledAt', 64], ['hours', 10], ['comment', 1000]] as const) requireDraft(validText(input[key], max));
  let selected: HandoffState['selected'] = null;
  if (v.selected !== null) {
    const s = draftObject(v.selected); draftKeys(s, ['action', 'preview', 'previewVersion'], s.action === 'issue' ? [] : ['handoffId', 'expectedRevision']);
    requireDraft(['issue', 'publish', 'renew', 'extend', 'revoke'].includes(s.action as string) && version(s.previewVersion));
    if (s.action !== 'issue') requireDraft(draftId(s.handoffId) && revision(s.expectedRevision));
    selected = { action: s.action as NonNullable<HandoffState['selected']>['action'], preview: parseSnapshot(s.preview), previewVersion: s.previewVersion as string,
      ...(s.action === 'issue' ? {} : { handoffId: s.handoffId as string, expectedRevision: s.expectedRevision as number }) };
  }
  const pending = v.pending === null ? null : handoffCommand(v.pending);
  requireDraft(v.status !== 'editing' || pending === null);
  requireDraft(!['saving', 'uncertain', 'saved'].includes(v.status as string) || pending !== null);
  requireDraft(!['saving', 'uncertain', 'conflict'].includes(v.status as string) || selected !== null);
  if (pending && selected) {
    requireDraft(pending.action === selected.action);
    if (pending.action !== 'issue') requireDraft(pending.handoffId === selected.handoffId && pending.expectedRevision === selected.expectedRevision);
    if (pending.action === 'issue' || pending.action === 'publish') requireDraft(pending.previewVersion === selected.previewVersion);
  }
  requireDraft((v.status === 'saved') === (v.receipt !== null));
  return { input: clone(input) as HandoffState['input'], selected, pending,
    receipt: v.receipt === null ? null : receipt(v.receipt, pending!, caseId, port),
    status: v.status === 'saving' ? 'uncertain' : v.status === 'editing' && selected ? 'conflict' : v.status as HandoffState['status'] };
}
