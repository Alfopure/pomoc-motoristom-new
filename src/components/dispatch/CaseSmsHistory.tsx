"use client";
import { useState } from "react";
import { Plus } from "lucide-react";
import { SmsHistory } from "./SmsHistory";

export function CaseSmsHistory({ caseId, embedded = false, onCompose }: {
  caseId: string;
  embedded?: boolean;
  onCompose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (embedded) return <section data-case-sms-history className="grid min-w-0 gap-4" aria-label="SMS k prípadu">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="text-sm font-semibold text-zinc-900">SMS k prípadu</h3><p className="mt-1 text-xs text-zinc-500">Správy a ich stav na jednom mieste.</p></div>
      {onCompose && <button type="button" onClick={onCompose} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"><Plus size={15} aria-hidden="true" />Nová SMS</button>}
    </div>
    <SmsHistory caseId={caseId} />
  </section>;
  return <details data-case-sms-history onToggle={(event) => setOpen(event.currentTarget.open)} className="rounded-xl border border-zinc-200 bg-white p-4">
    <summary className="cursor-pointer text-sm font-bold">História SMS prípadu</summary>
    {open && <div className="mt-4"><SmsHistory caseId={caseId} /></div>}
  </details>;
}
