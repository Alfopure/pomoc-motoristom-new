import { describe, expect, it } from 'vitest';
import type { TowingFields } from '@/domain/towing/types';
import { towingFieldsPatch } from './model';
import { towingCompletionProblems } from '@/domain/towing/validation';

const previous: TowingFields = { serviceType: 'tow', subjectType: 'vehicle', subjectDescription: 'Synthetic car', pickup: 'Synthetic A', destination: 'Synthetic B', startedAt: '2026-10-26T10:00:00Z', finishedAt: '2026-10-26T11:00:00Z', startSource: 'assignment', photoException: 'Synthetic documented exception' };

describe('actual towing start confirmation', () => {
  it('does not convert an assignment timestamp when only notes change', () => {
    expect(towingFieldsPatch({ ...previous, driverNotes: 'Synthetic note' }, previous)).toEqual({ driverNotes: 'Synthetic note' });
  });
  it('sends an explicitly confirmed start even when it equals the legacy assignment time', () => {
    expect(towingFieldsPatch({ ...previous, startSource: 'manual' }, previous)).toEqual({ startedAt: previous.startedAt });
  });
  it('requires confirmation of the physical start before completion', () => {
    expect(towingCompletionProblems({ fields: previous, attachments: [] })).toContain('Potvrďte skutočný začiatok výkonu; čas pridelenia nie je začiatok práce.');
    expect(towingCompletionProblems({ fields: { ...previous, startSource: 'manual' }, attachments: [] })).toEqual([]);
  });
});
