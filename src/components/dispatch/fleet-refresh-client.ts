import type { FleetData } from "@/data/dispatch-types";
import { diagnosticJson } from "@/lib/diagnostics/request";
export type FleetRefreshResponse = { fleetData: FleetData; summary?: { autoPaired: number; warnings: string[]; skipped?: boolean } };
let pending: Promise<FleetRefreshResponse> | null = null;
/** Every fleet panel in this tab shares the same provider refresh request. */
export function requestFleetRefresh(): Promise<FleetRefreshResponse> {
  if (pending) return pending;
  pending = (async () => {
    const { response, body } = await diagnosticJson<FleetRefreshResponse & { error?: string }>("fleet.refresh", "fleet", "/api/integrations/fleet/refresh", { method: "POST", cache: "no-store", signal: AbortSignal.timeout(305_000) }, {}, value => Boolean(value?.fleetData));
    if (!response.ok || !body.fleetData) throw new Error(body.error ?? "Obnova je nedostupná; zobrazujú sa posledné uložené údaje.");
    return body as FleetRefreshResponse;
  })().finally(() => { pending = null; });
  return pending;
}
