import { describe, expect, it } from 'vitest';
import { driverTowingFields, towingAssignmentProblems, towingCompletionProblems } from './validation';
import type { TowingFields, TowingRealizedItem } from './types';
const item: TowingRealizedItem = { id: '71000000-0000-4000-8000-000000000800', kind: 'storage', description: 'Storage', quantity: '1', unit: 'day' };
const fields: TowingFields = { serviceType: 'repair', subjectType: 'vehicle', subjectDescription: 'Fixture', branchId: 'branch', pickup: 'Here', contact: 'Fixture', startedAt: '2026-11-05T10:00:00Z', finishedAt: '2026-11-05T11:00:00Z', photoException: 'Fixture exception' };
describe('realized item guidance', () => {
  it('checks secondary storage and transport without demanding fictional vehicle identifiers', () => {
    expect(towingAssignmentProblems({ ...fields, subjectType: 'material', realizedItems: [item] }, 'driver')).toEqual(['Úkon 1: vyberte konkrétne parkovisko.']);
    expect(towingAssignmentProblems({ ...fields, realizedItems: [{ ...item, kind: 'relocation' }] }, 'driver')).toEqual(['Úkon 1: doplňte cieľ prepravy.']);
  });
  it('requires positive actual quantities on completion', () => {
    expect(towingCompletionProblems({ fields: { ...fields, realizedItems: [{ ...item, parkingId: 'parking', quantity: '' }] }, attachments: [] })).toEqual(['Úkon 1: doplňte opis, kladné množstvo a jednotku.']);
  });
  it('requires handover evidence for secondary transport too', () => {
    const problems = towingCompletionProblems({ fields: { ...fields, photoException: '', realizedItems: [{ ...item, kind: 'transport', destination: 'There' }] }, attachments: [{ id: 'photo', kind: 'work', name: 'fixture', mimeType: 'image/png', size: 1, status: 'ready', createdAt: '' }] });
    expect(problems).toEqual(['Pridajte fotografiu odovzdania alebo vysvetlite výnimku.']);
  });
  it('projects editable owner information without office identity or pricing', () => {
    expect(driverTowingFields({ ...fields, owner: { name: 'Owner', phone: '123', address: 'Here', companyId: '12345678', email: 'private', taxId: 'private' }, paymentIntent: 'card_terminal', realizedItems: [item] })).toMatchObject({ owner: { name: 'Owner', phone: '123', address: 'Here', companyId: '12345678' }, paymentIntent: 'card_terminal', realizedItems: [item] });
    expect(driverTowingFields({ ...fields, owner: { name: 'Owner', taxId: 'private' } }).owner).not.toHaveProperty('taxId');
  });
});
