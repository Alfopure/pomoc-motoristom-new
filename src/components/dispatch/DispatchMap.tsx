"use client";

import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import type { Branch, DispatchCase, FleetAsset, PriceRule } from "@/domain/types";

export type DispatchMapProps = {
  caseItem?: DispatchCase;
  branches: Branch[];
  assets: FleetAsset[];
  priceRule?: PriceRule;
  avoidMobileNav?: boolean;
  workspaceMode?: "collapsed" | "split" | "expanded";
  onAssignAsset?: (assetId: string) => void;
  onSendLocationSms?: () => void;
  onSendEtaSms?: () => void;
};

export function DispatchMap(props: DispatchMapProps) {
  const [GoogleMap, setGoogleMap] = useState<ComponentType<DispatchMapProps> | null>(null);

  useEffect(() => {
    let cancelled = false;
    import("./DispatchMapGoogle").then((module) => {
      if (!cancelled) {
        setGoogleMap(() => module.default);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!GoogleMap) {
    const loadingClassName =
      props.workspaceMode === "expanded"
        ? "flex h-full min-h-[180px] items-center justify-center rounded-md border border-zinc-200 bg-zinc-100 text-sm font-medium text-zinc-600 lg:min-h-0"
        : "flex h-full min-h-[360px] items-center justify-center rounded-md border border-zinc-200 bg-zinc-100 text-sm font-medium text-zinc-600 sm:min-h-[420px]";

    return (
      <div className={loadingClassName}>
        Načítava sa Google mapa
      </div>
    );
  }

  return <GoogleMap {...props} />;
}
