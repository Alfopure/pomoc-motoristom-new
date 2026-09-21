"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Eye, Loader2 } from "lucide-react";
import type { CaseEditorPresence } from "@/domain/case-collaboration";
import { draftPreviewGroups, type CaseDraftField } from "@/domain/case-draft-preview";
import { useCaseDraftPreview } from "./use-case-draft-preview";

export function CaseDraftPreviewItem({ editor }: { editor: CaseEditorPresence }) {
  const [open, setOpen] = useState(false), [visible, setVisible] = useState(false);
  const element = useRef<HTMLDivElement>(null), id = useId();
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  return <div ref={element} className="min-w-0 rounded-lg border border-sky-200 bg-white/80 text-xs text-sky-950">
    <button type="button" className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-sky-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
      aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <span className="size-2 shrink-0 rounded-full bg-sky-500 motion-safe:animate-pulse" aria-hidden="true" />
      <span className="min-w-0 flex-1"><span className="block break-words"><strong>{editor.displayName}</strong> má otvorený návrh prípadu</span><span className="mt-0.5 flex items-center gap-1 text-[11px] text-sky-800"><Eye size={12} aria-hidden="true" />{open ? "Skryť rozpracovaný prípad" : "Zobraziť rozpracovaný prípad"}</span></span>
      {open ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
    </button>
    <div id={id} hidden={!open}>{open && visible && <Preview sessionId={editor.sessionId} name={editor.displayName} />}</div>
  </div>;
}

function Preview({ sessionId, name }: { sessionId: string; name: string }) {
  const { snapshot, message, updating } = useCaseDraftPreview(sessionId, true);
  const fields = snapshot?.preview?.fields;
  return <section className="border-t border-sky-100" aria-label={`Rozpracovaný prípad – ${name}`}>
    <div className="flex items-start gap-2 px-3 py-2 text-[11px] text-zinc-600">
      {updating ? <Loader2 size={13} className="mt-0.5 shrink-0 motion-safe:animate-spin" aria-label="Načítavam náhľad" /> : <Eye size={13} className="mt-0.5 shrink-0" aria-hidden="true" />}
      <span>{message}. Údaje upravuje {name}.{snapshot?.updatedAt && <span className="mt-0.5 block">Posledná zmena o {new Date(snapshot.updatedAt).toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.</span>}</span>
    </div>
    {fields && <div className="max-h-[min(55vh,480px)] overflow-y-auto overscroll-contain px-3 pb-3" tabIndex={0} aria-label="Vyplnené údaje návrhu">
      {draftPreviewGroups.map(group => {
        const entries = Object.entries(group.fields).filter(([key]) => fields[key as CaseDraftField]);
        return entries.length ? <div key={group.title} className="mt-3 first:mt-0">
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{group.title}</h3>
          <dl className="space-y-2">{entries.map(([key, label]) => <div key={key} className="min-w-0 rounded-md bg-zinc-50 px-2 py-1.5">
            <dt className="text-[11px] text-zinc-500">{label}</dt><dd className="whitespace-pre-wrap break-words text-xs leading-relaxed text-zinc-950 [overflow-wrap:anywhere]">{fields[key as CaseDraftField]}</dd>
          </div>)}</dl>
        </div> : null;
      })}
      {!Object.values(fields).some(Boolean) && <p className="text-zinc-500">Kolega zatiaľ nevyplnil žiadne údaje.</p>}
    </div>}
  </section>;
}
