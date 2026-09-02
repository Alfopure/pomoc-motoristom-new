import { describe, expect, it } from "vitest";

import { __resetSwhouseCaches, SwhouseClient } from "./client";
import { swhouseConfigFromEnv } from "./config";
import { getReplacementVehicleSnapshot } from "./replacement-vehicles";
import { syncSwhouseFleet } from "./sync";

// Opt-in: SWHOUSE_SMOKE=1 + reálne SWHOUSE_* creds. Volá živé produkčné API (read-only). NIE v CI.
const RUN = process.env.SWHOUSE_SMOKE === "1";
const suite = RUN ? describe : describe.skip;

suite("SWHouse LIVE smoke (gated SWHOUSE_SMOKE=1)", () => {
  it(
    "logs in, fetches occupancy, manufacturers and aggregates",
    async () => {
      __resetSwhouseCaches();
      const config = swhouseConfigFromEnv();
      const client = new SwhouseClient(config);

      const occupancy = await client.getCarsOccupancy();
      expect(occupancy.ok).toBe(true);
      expect(Array.isArray(occupancy.data)).toBe(true);
      console.log("LIVE voľných vozidiel:", occupancy.data?.length);

      const allOccupancy = await client.getCarsOccupancyAll();
      expect(allOccupancy.ok).toBe(true);
      expect(Array.isArray(allOccupancy.data)).toBe(true);
      expect(allOccupancy.data?.length ?? 0).toBeGreaterThan(occupancy.data?.length ?? 0);
      expect(allOccupancy.data?.some((car) => car.lasFilialId != null)).toBe(true);
      console.log("LIVE všetkých flotilových vozidiel:", allOccupancy.data?.length);

      const manufacturers = await client.getManufacturers();
      expect(manufacturers.ok).toBe(true);
      expect((manufacturers.data?.length ?? 0)).toBeGreaterThan(0);

      const snapshot = await getReplacementVehicleSnapshot({ config });
      console.log(
        "LIVE availability:",
        JSON.stringify({
          ...snapshot,
          fleetOccupancy: snapshot?.fleetOccupancy
            ? { free: snapshot.fleetOccupancy.freePlates.length, occupied: snapshot.fleetOccupancy.occupiedPlates.length }
            : null,
        }),
      );
      expect(snapshot).not.toBeNull();
      expect(snapshot?.totalFree).toBeGreaterThan(0);
      expect(snapshot?.fleetOccupancy).not.toBeNull();
      expect(snapshot?.fleetOccupancy?.freePlates.length).toBeGreaterThan(0);
      expect(snapshot?.fleetOccupancy?.occupiedPlates.length).toBeGreaterThan(0);

      const dryRun = await syncSwhouseFleet({ dryRun: true, client, config });
      console.log(
        "LIVE roster dry-run:",
        JSON.stringify({
          status: dryRun.status,
          fleetCount: dryRun.fleetCount,
          recordsUpserted: dryRun.recordsUpserted,
          recordsDeactivated: dryRun.recordsDeactivated,
          linksRejected: dryRun.linksRejected,
          assetsCreated: dryRun.assetsCreated,
          assetsMatched: dryRun.assetsMatched,
          linksCreated: dryRun.linksCreated,
          ghostCount: dryRun.ghostCount,
          ambiguousCount: dryRun.ambiguousPlates.length,
          unmappedBranchCount: dryRun.unmappedBranchIds.length,
          error: dryRun.error,
        }),
      );
      expect(dryRun.status).toBe("success");
      expect(dryRun.fleetCount).toBe(allOccupancy.data?.length);
    },
    60_000,
  );
});
