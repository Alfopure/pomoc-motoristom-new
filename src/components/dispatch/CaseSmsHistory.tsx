"use client";
import { useState } from "react";
import { SmsHistory } from "./SmsHistory";
export function CaseSmsHistory({ caseId }: { caseId: string }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={(event) => setOpen(event.currentTarget.open)} className="rounded-xl border border-zinc-200 bg-white p-4">
    <summary className="cursor-pointer text-sm font-bold">História SMS prípadu</summary>
    {open && <div className="mt-4"><SmsHistory caseId={caseId} /></div>}
  </details>;
}
