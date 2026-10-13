import { describe, expect, it } from 'vitest';
import { calculateTowingLine, calculateTowingTotal, parseEuroCents, towingPaymentStatus } from './money';
import { capabilitiesForTowingRoles, driverTowingFields, towingCompletionProblems } from './validation';
import type { TowingFields } from './types';
describe('towing exact finance', () => {
  it('rounds half cents on net before tax and sums rounded lines', () => {
    const line = { id: 'line', description: 'Test', unit: 'ks', quantity: '1.005', unitPrice: '1', taxRate: '23' };
    expect(calculateTowingLine(line)).toEqual({ netCents: 101, taxCents: 23, totalCents: 124 });
    expect(calculateTowingTotal([line, line, line])).toBe(372);
    expect(calculateTowingLine({ quantity: '1', unitPrice: '0.025', taxRate: '50' })).toEqual({netCents: 3, taxCents: 2, totalCents: 5});
  });
  it('handles decimal values without binary floating point drift', () => {
    expect(calculateTowingLine({ quantity:'1000.001',unitPrice:'1.2345',taxRate:'20' })).toEqual({netCents:123450,taxCents:24690,totalCents:148140});
    expect(parseEuroCents('99,99')).toBe(9999);
    for (const invalid of ['-1','1.001','NaN','Infinity','1e3','0x10']) expect(() => parseEuroCents(invalid)).toThrow();
  });
  it('rejects precision/overflow and invalid quantities/rates', () => {
    for(const line of [{quantity:'0',unitPrice:'1',taxRate:'20'},{quantity:'1.0001',unitPrice:'1',taxRate:'20'},{quantity:'1',unitPrice:'1.00001',taxRate:'20'},{quantity:'1',unitPrice:'1',taxRate:'101'},{quantity:'999999999',unitPrice:'999999999',taxRate:'100'}]) expect(()=>calculateTowingLine(line)).toThrow();
  });
  it('keeps prepayment separate from due and identifies all payment statuses', () => {
    expect([towingPaymentStatus(null,100),towingPaymentStatus(100,0),towingPaymentStatus(100,50),towingPaymentStatus(100,100),towingPaymentStatus(100,150)]).toEqual(['unpriced','unpaid','partial','paid','overpaid']);
  });
});
describe('towing domain boundary', () => {
  const fields: TowingFields = {serviceType:'transport',subjectType:'machine',subjectDescription:'Stroj bez VIN',pickup:'A',destination:'B',startedAt:'2026-10-13T08:00:00Z',finishedAt:'2026-10-13T09:00:00Z',photoException:'Zákaz fotografovania u klienta'};
  it('machine/material completion needs no invented plate or VIN', () => expect(towingCompletionProblems({fields,attachments:[]})).toEqual([]));
  it('pending uploads and receipts block even an explicit photo exception', () => expect(towingCompletionProblems({fields,attachments:[{id:'a',kind:'work',name:'x.jpg',mimeType:'image/jpeg',size:10,status:'pending',createdAt:''}]},['receipt'])).toHaveLength(2));
  it('abandoned failed uploads do not block completion', () => expect(towingCompletionProblems({fields,attachments:[{id:'a',kind:'work',name:'failed.jpg',mimeType:'image/jpeg',size:10,status:'abandoned',createdAt:''}]})).toEqual([]));
  it('storage requires an identified parking site', () => expect(towingCompletionProblems({fields:{...fields,serviceType:'storage'},attachments:[]})).toContain('Vyberte parkovisko uloženia.'));
  it('driver capability is not legacy or office authorization; mixed role is explicit union', () => {
    expect(capabilitiesForTowingRoles(['driver'])).toEqual(['drive']);
    expect(capabilitiesForTowingRoles(['driver','dispatch'])).toEqual(['drive','operate','price','documents']);
    expect(driverTowingFields({...fields,customer:{name:'Office customer'}})).not.toHaveProperty('customer');
  });
});
