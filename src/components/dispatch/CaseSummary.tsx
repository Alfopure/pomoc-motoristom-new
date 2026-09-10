"use client";

import { useState } from "react";
import type { DispatchCase, FleetAsset, Operator } from "@/domain/types";
import { jobTypeLabels, paymentMethodLabels, paymentStatusLabels } from "@/domain/case-card";
import { casePriorityLabels, caseStatusLabels } from "@/domain/statuses";
import { formatTime } from "@/lib/dispatch-calculations";
import styles from "./case-detail.module.css";

/** A compact view of the saved case; pending edits stay in the editor below. */
export function CaseSummary({ caseItem, assets, operators = [], identityInHeader = false }: {
  caseItem: DispatchCase;
  assets: FleetAsset[];
  operators?: Operator[];
  identityInHeader?: boolean;
}) {
  const contact = caseItem.customerDetails.contacts?.find((item) => item.isPrimary)
    ?? caseItem.customerDetails.contacts?.[0] ?? caseItem.contact;
  const customer = caseItem.customerDetails.companyName || caseItem.customerDetails.assistanceServiceName
    || [caseItem.customerDetails.firstName, caseItem.customerDetails.lastName].filter(Boolean).join(" ") || contact.name;
  const asset = assets.find((item) => item.id === caseItem.selectedAssetId);
  const facts = [
    ["Prípad", !identityInHeader && `${caseItem.caseNumber} · ${caseStatusLabels[caseItem.status]} · ${casePriorityLabels[caseItem.priority]}`],
    ["Operátor", !identityInHeader && (operators.find((item) => item.id === caseItem.ownerId)?.name || caseItem.ownerName)],
    ["Klient / telefón", [customer, contact.phone].filter(Boolean).join(" · ")],
    ["Vozidlo", [caseItem.vehicle.licensePlate, caseItem.vehicle.make, caseItem.vehicle.model].filter(Boolean).join(" · ")],
    ["Miesto", caseItem.pickup?.address || caseItem.pickup?.label || caseItem.locationDetails.manualPickupAddress],
    ["Cieľ", caseItem.destination?.address || caseItem.destination?.label],
    ["Pridelená technika", asset ? [asset.label, asset.assignedDriverName].filter(Boolean).join(" · ") : undefined],
    ["Služba", caseItem.jobTypes.map((type) => jobTypeLabels[type]).join(", ")],
    ["Platba", [caseItem.paymentDetails.method && paymentMethodLabels[caseItem.paymentDetails.method],
      caseItem.paymentDetails.status && paymentStatusLabels[caseItem.paymentDetails.status]].filter(Boolean).join(" · ")],
    ["Uzavreté", caseItem.closureDetails.closedAt ? formatTime(caseItem.closureDetails.closedAt) : undefined],
  ].filter((fact): fact is [string, string] => Boolean(fact[1]));

  return (
    <section aria-label="Prehľad prípadu" data-testid="case-summary" className={styles.summary}>
      <div className={styles.summaryHeading}>
        <h3>Prehľad prípadu</h3>
        <span className={styles.savedLabel}>Uložené údaje · {formatTime(caseItem.updatedAt)}</span>
      </div>
      <dl className={styles.summaryFacts}>
        {facts.map(([label, value]) => (
          <div key={label} className={styles.summaryFact}>
            <dt>{label}</dt>
            <dd><SummaryText text={value} /></dd>
          </div>
        ))}
      </dl>
      {caseItem.nextStep && <div className={styles.nextStep}><span className={styles.nextStepLabel}>Ďalší krok</span><span><SummaryText text={caseItem.nextStep} /></span></div>}
      {caseItem.summary && <div className={styles.summaryDescription}><SummaryText text={caseItem.summary} /></div>}
    </section>
  );
}

function SummaryText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 180;
  return <>
    <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{long && !expanded ? `${text.slice(0, 180)}…` : text}</span>
    {long && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className={`${styles.expandText} rounded focus-visible:outline-2`}>{expanded ? "Zobraziť menej" : "Zobraziť viac"}</button>}
  </>;
}
