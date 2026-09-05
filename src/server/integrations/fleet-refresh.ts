import "server-only";
import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";
import { resolveDefaultOrganizationId } from "@/server/default-organization";
import { autoConfirmCommanderLinks } from "@/server/motorist-mutations";
import { syncWebdispecinkFleet } from "@/server/webdispecink-sync";
import { syncCommander } from "./commander/sync";
import { SwhouseClient } from "./swhouse/client";
import { swhouseConfigFromEnv } from "./swhouse/config";
import { computeLiveOccupancy } from "./swhouse/live-occupancy";
import { syncSwhouseOccupancy } from "./swhouse/occupancy-sync";
import { syncSwhouseFleet } from "./swhouse/sync";

const COOLDOWN_MS = 60_000;
const LEASE_MS = 330_000;
const object = (value: unknown): Record<string, Json | undefined> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, Json> : {};

export function fleetRefreshIsDue(state: unknown, now = Date.now()) {
  const lease = object(state);
  return !(Date.parse(String(lease.leaseUntil ?? "")) > now)
    && !(now - Date.parse(String(lease.lastStartedAt ?? "")) < COOLDOWN_MS);
}

/** Cross-instance compare-and-swap: Preview, production and every operator share one provider read budget. */
async function claimRefresh() {
  const supabase = createSupabaseAdminClient();
  const organizationId = await resolveDefaultOrganizationId();
  const ensure = await supabase.from("motorist_organization_integrations").upsert({
    organization_id: organizationId, provider: "client_vehicle_db", enabled: true, status: "configured",
  }, { onConflict: "organization_id,provider", ignoreDuplicates: true });
  if (ensure.error) throw new Error("Obnovu flotily sa nepodarilo pripraviť.");
  const read = await supabase.from("motorist_organization_integrations").select("id,config,updated_at")
    .eq("organization_id", organizationId).eq("provider", "client_vehicle_db").single();
  if (read.error || !read.data) throw new Error("Stav obnovy flotily je nedostupný.");
  const config = object(read.data.config);
  if (!fleetRefreshIsDue(config.fleetRefresh)) return null;
  const owner = randomUUID();
  const now = Date.now();
  const claimed = await supabase.from("motorist_organization_integrations").update({ config: {
    ...config, fleetRefresh: { owner, lastStartedAt: new Date(now).toISOString(), leaseUntil: new Date(now + LEASE_MS).toISOString() },
  } }).eq("id", read.data.id).eq("updated_at", read.data.updated_at).select("id");
  if (claimed.error) throw new Error("Obnovu flotily sa nepodarilo rezervovať.");
  if (!claimed.data?.length) return null;
  return async () => {
    const latest = await supabase.from("motorist_organization_integrations").select("config,updated_at").eq("id", read.data.id).single();
    if (!latest.data) return;
    const current = object(latest.data.config), lease = object(current.fleetRefresh);
    if (lease.owner !== owner) return;
    await supabase.from("motorist_organization_integrations").update({ config: {
      ...current, fleetRefresh: { ...lease, leaseUntil: null, lastCompletedAt: new Date().toISOString() },
    } }).eq("id", read.data.id).eq("updated_at", latest.data.updated_at);
  };
}

/** UI-driven refresh only. No worker, listener or additional cron is deployed. */
export async function refreshFleetSources() {
  const summary = {
    commanderVehicles: false, commanderPositions: false, swhouse: false, occupancy: false,
    webdispecink: false, autoPaired: 0, skipped: false, warnings: [] as string[],
  };
  const release = await claimRefresh();
  if (!release) return { ...summary, skipped: true };
  try {
    const providers = await Promise.allSettled([
      (async () => {
        try { summary.commanderVehicles = (await syncCommander({ mode: "vehicles" })).status === "success"; }
        catch { /* independent positions read below */ }
        try { summary.commanderPositions = (await syncCommander({ mode: "positions" })).status === "success"; }
        catch { /* last known positions are preserved */ }
        if (!summary.commanderVehicles || !summary.commanderPositions) summary.warnings.push("Commander: katalóg alebo GPS sa nepodarilo úplne obnoviť.");
      })(),
      (async () => {
        try {
          const config = swhouseConfigFromEnv();
          const client = new SwhouseClient(config);
          const [all, free] = await Promise.all([client.getCarsOccupancyAll({ fresh: true }), client.getCarsOccupancy({ fresh: true })]);
          if (!all.ok || !free.ok || !Array.isArray(all.data) || !Array.isArray(free.data)) throw new Error("source unavailable");
          computeLiveOccupancy(all.data, free.data, config.fleetOwnerTypeIds);
          const capturedAt = new Date().toISOString();
          summary.swhouse = (await syncSwhouseFleet({ client, config, allCars: all.data })).status === "success";
          if (!summary.swhouse) throw new Error("roster validation failed");
          summary.occupancy = (await syncSwhouseOccupancy({ client, config, snapshot: { allCars: all.data, freeCars: free.data, capturedAt } })).status === "success";
          if (!summary.occupancy) throw new Error("occupancy validation failed");
        } catch {
          summary.warnings.push("Software House: roster alebo obsadenosť sa neobnovili. Posledné údaje zostávajú zachované.");
          const admin = createSupabaseAdminClient();
          const orgId = await resolveDefaultOrganizationId();
          await admin.from("motorist_organization_integrations").update({ status: "degraded", last_error_at: new Date().toISOString(), last_error: "Živý roster alebo obsadenosť sa nepodarilo overiť." })
            .eq("organization_id", orgId).eq("provider", "client_vehicle_db");
        }
      })(),
      (async () => {
        try { await syncWebdispecinkFleet({ mode: "full" }); summary.webdispecink = true; }
        catch { summary.warnings.push("WebDispečink: GPS sa nepodarilo obnoviť."); }
      })(),
    ]);
    if (providers.some((provider) => provider.status === "rejected")) summary.warnings.push("Jeden zo zdrojov sa nepodarilo zapísať. Obnova ostatných zdrojov pokračovala.");
    if (summary.swhouse && summary.commanderVehicles) {
      try { summary.autoPaired = (await autoConfirmCommanderLinks()).autoPaired; }
      catch { summary.warnings.push("Automatické párovanie sa nepodarilo dokončiť."); }
    }
    return summary;
  } finally { await release(); }
}
