import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RoutingDiagnostic } from '@/lib/diagnostics/routing';
import { DiagnosticRoutingTimeline } from './DiagnosticTimeline';

const selection: RoutingDiagnostic = {
  version: 1, at: '2026-10-03T13:45:29.000Z', kind: 'selection', step: 0, strategy: 'all', ringSecs: 20,
  startedAt: '2026-10-03T13:45:29.000Z', deadlineAt: '2026-10-03T13:45:54.000Z', reason: null,
  selectedCount: 1, skippedCount: 1, omittedMembers: 0, activeLegCount: 1, maxConcurrentLegs: 12, maxFanout: 8,
  members: [{ memberId: null, profileId: '00000000-0000-0000-0000-000000000001', endpoint: 'sip', outcome: 'skipped', reason: 'device_stale', presence: 'available', registration: 'registering', heartbeatAgeMs: 500, openOffer: false }],
};
describe('routing evidence presentation', () => {
  it('shows requested 20-second ring window separately from the recovery grace and audible ringing', () => {
    const html = renderToStaticMarkup(<DiagnosticRoutingTimeline profiles={{ '00000000-0000-0000-0000-000000000001': 'Mário Šalásek' }} routing={[selection, { ...selection, kind: 'completed', at: '2026-10-03T13:45:49.000Z', reason: 'all_offers_finished', members: [] }, { ...selection, kind: 'fallback', at: '2026-10-03T13:45:50.000Z', reason: 'external_number', members: [] }]} />);
    expect(html).toContain('15:45:29 → 03. 10. 15:45:49 (20 s)');
    expect(html).toContain('Kontrola pri chýbajúcom potvrdení ukončenia: 03. 10. 15:45:54');
    expect(html).toContain('Nepotvrdzujú, že mobil skutočne vydal zvuk.');
    expect(html).toContain('Registrácia alebo odozva zariadenia nie je aktuálna');
    expect(html).toContain('registruje sa');
    expect(html).toContain('Mário Šalásek');
    expect(html).toContain('Prechod na záložné číslo');
    expect(html).toContain('Od prvého výberu zariadení: 21 s');
  });
  it('distinguishes missing historical evidence, unavailable reads, and incomplete records', () => {
    const absent = renderToStaticMarkup(<DiagnosticRoutingTimeline routing={[]} />);
    const unavailable = renderToStaticMarkup(<DiagnosticRoutingTimeline unavailable />);
    const truncated = renderToStaticMarkup(<DiagnosticRoutingTimeline routing={[selection]} truncated />);
    expect(absent).toContain('Staršie hovory ich nemuseli zaznamenávať');
    expect(unavailable).toContain('nepodarilo načítať');
    expect(unavailable).not.toContain('Staršie hovory');
    expect(truncated).toContain('len časť dostupných rozhodnutí');
  });
});
