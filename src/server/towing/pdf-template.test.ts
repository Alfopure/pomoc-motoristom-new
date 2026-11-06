import { describe, expect, it } from 'vitest';
import { renderTowingPdf, type TowingPdfSnapshot } from './pdf-template';
const base: TowingPdfSnapshot = { number: 'FIXTURE', kind: 'work', fields: { serviceType: 'repair', subjectType: 'vehicle', subjectDescription: 'Fixture', pickup: 'Here' } };
describe('new operational PDF facts', () => {
  it('renders realized facts and agreed payment as a plan with no invented receipt', () => {
    const snapshot: TowingPdfSnapshot = { ...base, fields: { ...base.fields, odometer: '123.5', dispatchInstructions: '<Move safely>', paymentIntent: 'card_terminal', handoverRecipientName: 'Fixture recipient', handedOverAt: '2026-11-05T12:00:00Z', realizedItems: [{ id: 'fixture-item', kind: 'storage', description: 'Fixture storage', quantity: '2', unit: 'day', parkingName: 'Fixture lot', parkingAddress: 'Exact fixture street' }] } };
    const before = JSON.stringify(snapshot);
    const html = renderTowingPdf(snapshot, 'snapshot-hash');
    for (const text of ['Stav tachometra (km)', '123.5', '&lt;Move safely&gt;', 'Fixture storage', '2 day', 'Fixture lot', 'Exact fixture street', 'Dohodnutá forma úhrady – plán', 'Tento údaj nepotvrdzuje prijatie peňazí ani vystavenie faktúry.', 'Fixture recipient', '2026-11-05T12:00:00Z']) expect(html).toContain(text);
    expect(html).not.toContain('<Move safely>');
    expect(html).not.toContain('Cena bez dane');
    expect(JSON.stringify(snapshot)).toBe(before);
    for (const party of ['Objednávateľ', 'Príjemca', 'Dopravca']) expect(html).toContain(`${party}<br>Meno:<br>Podpis:`);
  });
  it('does not invent optional details in a historical snapshot', () => {
    const html = renderTowingPdf(base, 'historical-hash');
    expect(html).not.toContain('Dohodnutá forma úhrady');
    expect(html).not.toContain('Realizované úkony');
    expect(html).not.toContain('Odovzdanie vozidla');
    expect(html).toContain('historical-hash');
  });
});
