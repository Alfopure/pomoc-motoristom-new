"use client";

import { useState } from "react";
import type { DispatchCase, FleetAsset, Operator } from "@/domain/types";
import { jobTypeLabels, paymentMethodLabels, paymentStatusLabels } from "@/domain/case-card";
import { casePriorityLabels, caseStatusLabels } from "@/domain/statuses";
import { formatTime } from "@/lib/dispatch-calculations";

/** A compact view of the saved case; pending edits stay in the editor below. */
export function CaseSummary({ caseItem, assets, operators = [] }: {
  caseItem: DispatchCase;
  assets: FleetAsset[];
  operators?: Operator[];
}) {
  const contact = caseItem.customerDetails.contacts?.find((item) => item.isPrimary)
    ?? caseItem.customerDetails.contacts?.[0] ?? caseItem.contact;
  const customer = caseItem.customerDetails.companyName || caseItem.customerDetails.assistanceServiceName
    || [caseItem.customerDetails.firstName, caseItem.customerDetails.lastName].filter(Boolean).join(" ") || contact.name;
  const asset = assets.find((item) => item.id === caseItem.selectedAssetId);
  const facts = [
    ["Prípad", `${caseItem.caseNumber} · ${caseStatusLabels[caseItem.status]} · ${casePriorityLabels[caseItem.priority]}`],
    ["Operátor", operators.find((item) => item.id === caseItem.ownerId)?.name || caseItem.ownerName],
    ["Klient / telefón", [customer, contact.phone].filter(Boolean).join(" · ")],
    ["Vozidlo", [caseItem.vehicle.licensePlate, caseItem.vehicle.make, caseItem.vehicle.model].filter(Boolean).join(" · ")],
    ["Miesto", caseItem.pickup?.address || caseItem.pickup?.label || caseItem.locationDetails.manualPickupAddress],
    ["Cieľ", caseItem.destination?.address || caseItem.destination?.label],
    ["Pridelená technika", asset ? [asset.label, asset.assignedDriverName].filter(Boolean).join(" · ") : undefined],
    ["Služba", caseItem.jobTypes.map((type) => jobTypeLabels[type]).join(", ")],
    ["Platba", [caseItem.paymentDetails.method && paymentMethodLabels[caseItem.paymentDetails.method],
      caseItem.paymentDetails.status && paymentStatusLabels[caseItem.paymentDetails.status]].filter(Boolean).join(" · ")],
    ["Aktualizované", formatTime(caseItem.updatedAt)],
    ["Uzavreté", caseItem.closureDetails.closedAt ? formatTime(caseItem.closureDetails.closedAt) : undefined],
  ].filter((fact): fact is [string, string] => Boolean(fact[1]));

  return (
    <section aria-label="Prehľad prípadu" data-testid="case-summary" className="min-w-0 rounded-lg border border-zinc-200 bg-white p-3">
      <h3 className="mb-2 text-sm font-semibold text-zinc-950">Prehľad prípadu</h3>
      <dl className="grid min-w-0 gap-x-4 gap-y-2 @sm:grid-cols-2 @3xl:grid-cols-3">
        {facts.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs font-medium text-zinc-500">{label}</dt>
            <dd className="text-sm font-semibold leading-5 text-zinc-900"><SummaryText text={value} /></dd>
          </div>
        ))}
      </dl>
      {caseItem.nextStep && <div className="mt-3 rounded-md bg-yellow-50 p-2 text-sm font-semibold text-zinc-900"><span className="mr-1 text-zinc-500">Ďalší krok:</span><SummaryText text={caseItem.nextStep} /></div>}
      {caseItem.summary && <div className="mt-2 text-sm text-zinc-700"><SummaryText text={caseItem.summary} /></div>}
    </section>
  );
}

function SummaryText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 180;
  return <>
    <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{long && !expanded ? `${text.slice(0, 180)}…` : text}</span>
    {long && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="ml-1 inline-flex min-h-11 items-center rounded px-2 text-xs font-semibold text-zinc-700 underline focus-visible:outline-2">{expanded ? "Zobraziť menej" : "Zobraziť viac"}</button>}
  </>;
}
