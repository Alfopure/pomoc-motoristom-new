'use client';
import { useState } from 'react';
import { PartnersModule } from './PartnersModule';

export function CasePartnerPanel({ caseId, embedded = false }: { caseId: string; embedded?: boolean }) {
  const [visited, setVisited] = useState(false);
  if (embedded) return <section className="case-partner-embedded min-w-0" aria-label="Partner, konzultácia a zúčtovanie"><PartnersModule caseId={caseId} /></section>;
  return <details className="rounded-lg border border-zinc-200 bg-white" onToggle={event => { if (event.currentTarget.open) setVisited(true); }}>
    <summary className="cursor-pointer px-3 py-3 text-sm font-semibold text-zinc-800">Partner, konzultácia a zúčtovanie</summary>
    {visited && <PartnersModule caseId={caseId} />}
  </details>;
}
