import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DiagnosticPhoneCounts, DiagnosticPhoneStatus } from '@/lib/diagnostics/phone-status';
import type { MonitorResource } from './useMonitorResource';
import { PhoneStatusCard } from './PhoneStatusCard';

const now = Date.parse('2026-11-04T10:00:00.000Z');
const empty: DiagnosticPhoneCounts = { source: 'available', total: 0, ready: 0, pushReachable: 0, error: 0, registering: 0, unregistered: 0, stale: 0, unknown: 0, lastSeenAt: null, truncated: false };
const data: DiagnosticPhoneStatus = { checkedAt: new Date(now).toISOString(), environment: 'production', heartbeatWindowMs: 120000, browser: empty, mobile: empty };
const resource = (value: DiagnosticPhoneStatus | null = data): MonitorResource<DiagnosticPhoneStatus> => ({ data: value, loading: false, error: null, observedAt: now, denied: false, refresh() {} });

describe('phone status presentation', () => {
  it('never calls an empty inventory healthy or confirmed working audio', () => {
    const html = renderToStaticMarkup(<PhoneStatusCard resource={resource()} now={now} />);
    expect(html).toContain('Žiadne evidované zariadenia; funkčnosť telefonovania neoverená');
    expect(html).toContain('nepotvrdzujú zvonenie či zvuk v hovore');
    expect(html).not.toContain('v poriadku');
  });
  it('expires old and future observations independently of response receipt time', () => {
    expect(renderToStaticMarkup(<PhoneStatusCard resource={resource()} now={now + 120000} />)).toContain('Zastarané overenie');
    expect(renderToStaticMarkup(<PhoneStatusCard resource={resource({ ...data, checkedAt: new Date(now + 120000).toISOString() })} now={now} />)).toContain('Stav neoverený');
    expect(renderToStaticMarkup(<PhoneStatusCard resource={resource(null)} now={now} />)).toContain('Stav neoverený');
  });
  it('exposes fresh errors, partial sources and failed refreshes instead of reusing a healthy label', () => {
    expect(renderToStaticMarkup(<PhoneStatusCard resource={resource({ ...data, browser: { ...empty, total: 1, error: 1 } })} now={now} />)).toContain('Telefón hlási chybu');
    const partial = renderToStaticMarkup(<PhoneStatusCard resource={resource({ ...data, mobile: { ...empty, source: 'unavailable' } })} now={now} />);
    expect(partial).toContain('Neúplné overenie'); expect(partial).toContain('Údaje sa nepodarilo overiť');
    const truncated = renderToStaticMarkup(<PhoneStatusCard resource={resource({ ...data, browser: { ...empty, total: 500, ready: 500, truncated: true } })} now={now} />);
    expect(truncated).toContain('počty nie sú úplné'); expect(truncated).toContain('Neúplné počty');
    expect(renderToStaticMarkup(<PhoneStatusCard resource={{ ...resource(), error: 'Nepodarilo sa obnoviť.' }} now={now} />)).toContain('Obnovenie neúspešné');
  });
});
