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

it('imports realization identities once without overwriting negotiated prices', async () => {
  const { importRealizedItems } = await import('./model');
  const existing = { id: '11111111-1111-4111-8111-111111111111', description: 'Existing agreed line', quantity: '2', unit: 'km', unitPrice: '15', taxRate: '5' };
  const items = [
    { id: existing.id, kind: 'tow' as const, description: 'Changed operational description', quantity: '9', unit: 'km' },
    { id: '22222222-2222-4222-8222-222222222222', kind: 'storage' as const, description: 'Uloženie', quantity: '3', unit: 'deň' },
  ];
  const imported = importRealizedItems([existing], items);
  expect(imported[0]).toEqual(existing);
  expect(imported[1]).toEqual({ id: items[1].id, description: 'Uloženie', quantity: '3', unit: 'deň', unitPrice: '', taxRate: '' });
  expect(importRealizedItems(imported, items)).toEqual(imported);
});
