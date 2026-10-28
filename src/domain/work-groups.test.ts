import { describe, expect, it } from 'vitest';
import { formatDuration, workState, type WorkExecution } from './work-groups';
const execution = (patch: Partial<WorkExecution>): WorkExecution => ({ operationId: 'o', owner: 'logistics', ownerId: 'o', status: 'assigned', revision: 1, assigneeId: 'm', assignee: 'M', scheduledAt: null, plannedEndAt: null, confirmedAt: null, startedAt: null, finishedAt: null, done: false, cancelled: false, ...patch });
describe('branch work display', () => {
  it('keeps unknown report timings visible instead of zero', () => {
    expect(formatDuration(null)).toBe('neznáme');
    expect(formatDuration(undefined)).toBe('neznáme');
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(125)).toBe('2 min');
    expect(formatDuration(3 * 3600 + 20 * 60)).toBe('3 h 20 min');
  });
  it('lets the materialized execution decide the visible state', () => {
    expect(workState({ status: 'queued', execution: null })).toBe('queued');
    expect(workState({ status: 'claimed', execution: null })).toBe('claimed');
    expect(workState({ status: 'assigned', execution: execution({}) })).toBe('assigned');
    expect(workState({ status: 'assigned', execution: execution({ startedAt: '2026-10-28T08:00:00Z' }) })).toBe('in_progress');
    expect(workState({ status: 'assigned', execution: execution({ done: true }) })).toBe('done');
    expect(workState({ status: 'assigned', execution: execution({ cancelled: true }) })).toBe('cancelled');
    expect(workState({ status: 'cancelled', execution: null })).toBe('cancelled');
  });
});
