import { describe, expect, it } from 'vitest';
import { context } from './fixtures';
import { snapshotRows } from './summary-rows';
describe('complete recipient preview', () => {
  it('renders false, zero coordinates and all replacement details even when unnecessary', () => {
    const rows = Object.fromEntries(snapshotRows(context().preview));
    expect(rows['Pojazdné']).toBe('Nie');
    expect(rows['Počet osôb']).toBe('0');
    expect(rows['Šírka · Miesto úkonu']).toBe('0');
    expect(rows['Náhradné vozidlo potrebné']).toBe('Nie');
    expect(rows['Pristavenie náhradného vozidla']).toBe('MOCK doručenie');
    expect(rows['Úkon']).toBe('Odťah');
    expect(rows['Referencia asistenčky']).toBe('REF42');
    expect(rows['Model náhradného vozidla']).toBe('Neuvedené');
    expect(Object.keys(rows)).toHaveLength(35);
  });
  it('preserves all full text and instruction fields', () => {
    const v = context().preview;
    v.instructions = 'Úplné pokyny\nDruhý riadok';
    expect(Object.fromEntries(snapshotRows(v))['Pokyny pre kolegu']).toBe(v.instructions);
  });
});
