"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { DispatchData } from "@/data/dispatch-types";
import type { Branch, DispatchCase, FleetAsset, PartnerDirectoryEntry, PriceRule } from "@/domain/types";
import { CaseDetail } from "./CaseDetail";

type CaseDrawerProps = {
  caseItem: DispatchCase;
  branches: Branch[];
  assets: FleetAsset[];
  partnerDirectory: PartnerDirectoryEntry[];
  priceRule: PriceRule;
  focusedTaskId?: string;
  open: boolean;
  onClose: () => void;
  onDataChange?: (dispatchData: DispatchData) => void;
  viewerProfileId?: string;
};

export function CaseDrawer({ caseItem, branches, assets, focusedTaskId, onDataChange, partnerDirectory, priceRule, open, onClose, viewerProfileId }: CaseDrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  return (
    <div
      aria-hidden={!open}
      aria-labelledby="case-drawer-title"
      aria-modal="true"
      inert={open ? undefined : true}
      role="dialog"
      className={`fixed inset-y-0 right-0 z-[2147483200] w-full max-w-5xl border-l border-zinc-200 bg-white shadow-2xl transition-transform duration-200 ${
        open ? "translate-x-0" : "pointer-events-none translate-x-full"
      }`}
    >
      <div className="flex h-14 items-center justify-between border-b border-zinc-200 px-4">
        <span id="case-drawer-title" className="text-sm font-semibold uppercase tracking-normal text-zinc-600">
          Karta prípadu
        </span>
        <button ref={closeButtonRef} type="button" onClick={onClose} className="rounded-md border border-zinc-200 p-2 text-zinc-600 hover:bg-zinc-50" aria-label="Zavrieť kartu prípadu">
          <X size={18} />
        </button>
      </div>
      <div className="h-[calc(100%-56px)] overflow-auto p-3 sm:p-4" data-case-detail-scroll-region>
        {open ? (
          <CaseDetail
            key={caseItem.id}
            caseItem={caseItem}
            branches={branches}
            assets={assets}
            focusedTaskId={focusedTaskId}
            onDataChange={onDataChange}
            partnerDirectory={partnerDirectory}
            priceRule={priceRule}
            viewerProfileId={viewerProfileId}
          />
        ) : null}
      </div>
    </div>
  );
}
