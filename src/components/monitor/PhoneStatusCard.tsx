import type { DiagnosticPhoneCounts, DiagnosticPhoneStatus } from '@/lib/diagnostics/phone-status';
import { freshness, timestamp } from './monitor-model';
import type { MonitorResource } from './useMonitorResource';

function PhoneSource({ title, counts }: { title: string; counts: DiagnosticPhoneCounts }) {
  return <div className="rounded-md bg-zinc-50 p-3">
    <h3 className="text-xs font-semibold">{title}</h3>
    {counts.source === 'unavailable' ? <p className="mt-1 text-xs text-amber-900">Údaje sa nepodarilo overiť.</p>
      : counts.total === 0 ? <p className="mt-1 text-xs text-zinc-500">Žiadne evidované zariadenia; funkčnosť telefonovania neoverená.</p>
        : <><dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-xs">
          <dt>Registrované · čerstvá odozva</dt><dd>{counts.ready}</dd>
          {title === 'Mobilná aplikácia' && <><dt>Dosiahnuteľné cez push lease</dt><dd>{counts.pushReachable}</dd></>}
          <dt>Čerstvo hlásená chyba</dt><dd className={counts.error ? 'font-semibold text-amber-900' : ''}>{counts.error}</dd>
          <dt>Registrujú sa</dt><dd>{counts.registering}</dd>
          <dt>Neregistrované · čerstvá odozva</dt><dd>{counts.unregistered}</dd>
          <dt>Stará odozva</dt><dd>{counts.stale}</dd>
          <dt>Stav nezistený</dt><dd>{counts.unknown}</dd>
        </dl><p className="mt-2 text-xs text-zinc-500">Posledná odozva: {timestamp(counts.lastSeenAt)}</p></>}
    {counts.truncated && <p role="status" className="mt-2 text-xs text-amber-900">Zobrazená iba časť evidovaných zariadení; počty nie sú úplné.</p>}
  </div>;
}

export function PhoneStatusCard({ resource, now }: { resource: MonitorResource<DiagnosticPhoneStatus>; now: number }) {
  const data = resource.data;
  const state = freshness(data ? Date.parse(data.checkedAt) : null, now, 120_000);
  const label = resource.error ? 'Obnovenie neúspešné' : state === 'stale' ? 'Zastarané overenie' : state !== 'fresh' ? 'Stav neoverený'
    : data && (data.browser.source === 'unavailable' || data.mobile.source === 'unavailable') ? 'Neúplné overenie'
      : data && (data.browser.truncated || data.mobile.truncated) ? 'Neúplné počty'
        : data && data.browser.error + data.mobile.error > 0 ? 'Telefón hlási chybu' : 'Prehľad evidovaných stavov';
  return <section className="rounded-lg border border-zinc-200 bg-white p-4" aria-label="Stav telefónov">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">Stav telefónov</h2><span className="rounded-md bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900">{label}</span></div>
    <p className="mt-2 text-xs leading-5 text-zinc-500">Samostatný stav zariadení, nie výsledok kontroly aplikácie. Čerstvá odozva je najviac 2 minúty stará. Registrácia ani push lease nepotvrdzujú zvonenie či zvuk v hovore.</p>
    {resource.error && <p role="alert" className="mt-2 text-xs text-amber-900">{resource.error}</p>}
    {data && <><div className="mt-3 grid gap-3 sm:grid-cols-2"><PhoneSource title="Prehliadač" counts={data.browser} /><PhoneSource title="Mobilná aplikácia" counts={data.mobile} /></div><p className="mt-2 text-xs text-zinc-500">Overené: {timestamp(data.checkedAt)} · Evidencia zahŕňa aj zariadenia mimo služby. Nulový počet nezaručuje funkčné telefonovanie.</p></>}
  </section>;
}
