import { describe, expect, it } from 'vitest';
import { buildRentalDraft } from './rental-draft';
const base = { operationId: 'op', caseId: 'case', caseNumber: 'PM-1', caseAssistanceReference: null, contactPhone: '+421900000001', branchName: 'Žilina' };
describe('rental draft mapping', () => {
  it('maps only the agreed contract fields of a person', () => {
    const draft = buildRentalDraft({ ...base, customer: { type: 'person', firstName: 'Ján', lastName: 'Novák', assistanceServiceName: 'Europ Assistance', assistanceReference: 'EA-77', contacts: [{ phone: '+421900000002', isPrimary: true }] } });
    expect(Object.fromEntries(draft.fields.map(field => [field.key, field.value]))).toEqual({ assistance: 'Europ Assistance', caseReference: 'EA-77', branch: 'Žilina', firstName: 'Ján', lastName: 'Novák', phone: '+421900000002' });
    expect(draft.missing).toEqual([]);
    expect(draft.origin).toBe('Prenesené z dispečingu');
    expect(draft.connection.state).toBe('not_connected');
  });
  it('uses the company name for a company and lists what is missing', () => {
    const draft = buildRentalDraft({ ...base, branchName: null, customer: { type: 'company', companyName: 'Firma s.r.o.' } });
    expect(draft.personType).toBe('company');
    expect(draft.fields.find(field => field.key === 'caseReference')?.value).toBe('PM-1');
    expect(draft.fields.find(field => field.key === 'phone')?.value).toBe('+421900000001');
    expect(draft.missing).toEqual(['Asistenčná služba', 'Pobočka']);
  });
});
