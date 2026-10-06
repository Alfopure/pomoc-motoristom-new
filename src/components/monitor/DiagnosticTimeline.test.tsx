import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RoutingDiagnostic } from '@/lib/diagnostics/routing';
import { DiagnosticEvents, DiagnosticRoutingTimeline } from './DiagnosticTimeline';
import type { DiagnosticStoredEvent } from '@/lib/diagnostics/types';

const selection: RoutingDiagnostic = {
  version: 1, at: '2026-10-03T13:45:29.000Z', kind: 'selection', step: 0, strategy: 'all', ringSecs: 20,
  startedAt: '2026-10-03T13:45:29.000Z', deadlineAt: '2026-10-03T13:45:54.000Z', reason: null,
  selectedCount: 1, skippedCount: 1, omittedMembers: 0, activeLegCount: 1, maxConcurrentLegs: 12, maxFanout: 8,
  members: [{ memberId: null, profileId: '00000000-0000-0000-0000-000000000001', endpoint: 'sip', outcome: 'skipped', reason: 'device_stale', presence: 'available', registration: 'registering', heartbeatAgeMs: 500, openOffer: false }],
};
describe('routing evidence presentation', () => {
  it('presents the allowlisted voice observation with its code without asserting an outage', () => {
    const event: DiagnosticStoredEvent = {
      id: '00000000-0000-4000-8000-000000000001', pageId: '00000000-0000-4000-8000-000000000002', sequence: 1,
      occurredAt: '2026-10-06T10:00:00.000Z', receivedAt: '2026-10-06T10:00:01.000Z', monotonicMs: 1,
      type: 'phone_lifecycle', module: 'telephony', outcome: 'unknown', buildId: 'test-build', sampled: false, sampleRate: 1,
      callSessionId: '00000000-0000-4000-8000-000000000003', sdkWarningCode: 31006, reason: 'sdk_low_inbound_audio',
      profileId: null, source: 'browser', serverBuild: 'test-build',
    };
    const html = renderToStaticMarkup(<DiagnosticEvents events={[event]} />);
    expect(html).toContain('Nízka úroveň prijímaného zvuku');
    expect(html).toContain('31006');
    expect(html).toContain('Výsledok nezistený');
    expect(html).toContain('samo nepotvrdzuje výpadok ani príčinu');
    expect(html).toContain('Ticho môže byť zámerné.');
    expect(html).toContain('Počuteľnosť oboma smermi treba overiť pri hovore.');
  });
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
