"use client";

import { useEffect, useState } from "react";

export type ReplacementVehicleAvailability = {
  /** internalBranchId -> počet voľných náhradných vozidiel (živé zo SWHouse) */
  byBranch: Record<string, number>;
  /** Normalizované ECV aktuálne voľných náhradných vozidiel v SWHouse. */
  freePlates: ReadonlySet<string>;
  /** Normalizované ECV aktuálne obsadených náhradných vozidiel v SWHouse (flotila mínus voľné). */
  occupiedPlates: ReadonlySet<string>;
  source: "swhouse" | "fallback";
  loading: boolean;
};

type AvailabilityPayload = {
  availabilityByBranch?: Record<string, number>;
  fleetOccupancy?: { freePlates?: string[]; occupiedPlates?: string[] } | null;
  source?: "swhouse" | "fallback";
};

const EMPTY_PLATES: ReadonlySet<string> = new Set();
const INITIAL: ReplacementVehicleAvailability = {
  byBranch: {},
  freePlates: EMPTY_PLATES,
  occupiedPlates: EMPTY_PLATES,
  source: "fallback",
  loading: true,
};

/**
 * Client-side hydration živých počtov náhradných vozidiel z SWHouse.
 * Beží mimo render critical path — page sa vyrenderuje s manuálnou hodnotou, živé číslo dotečie po mount.
 * Pri zlyhaní ostáva source:"fallback" (UI ukáže manuálnu hodnotu).
 */
export function useReplacementVehicleAvailability(): ReplacementVehicleAvailability {
  const [state, setState] = useState<ReplacementVehicleAvailability>(INITIAL);

  useEffect(() => {
    let active = true;
    fetch("/api/integrations/swhouse/replacement-vehicles", { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<AvailabilityPayload>) : Promise.reject(new Error("fetch failed"))))
      .then((payload) => {
        if (!active) {
          return;
        }
        setState({
          byBranch: payload.availabilityByBranch ?? {},
          freePlates: new Set(payload.fleetOccupancy?.freePlates ?? []),
          occupiedPlates: new Set(payload.fleetOccupancy?.occupiedPlates ?? []),
          source: payload.source ?? "fallback",
          loading: false,
        });
      })
      .catch(() => {
        if (active) {
          setState((previous) => ({ ...previous, loading: false }));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return state;
}
