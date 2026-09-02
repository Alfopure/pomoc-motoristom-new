import { getReplacementVehicleSnapshot } from "@/server/integrations/swhouse/replacement-vehicles";
import { motoristAccessGuard } from "@/server/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // live read — nikdy necachovať

type AvailabilityResponse = {
  availabilityByBranch: Record<string, number>;
  unassignedCount: number;
  totalFree: number;
  /** ECV sety na párovanie obsadenosti flotily; null = párovanie nedostupné. */
  fleetOccupancy: { freePlates: string[]; occupiedPlates: string[] } | null;
  source: "swhouse" | "fallback";
  fetchedAt: string;
};

function fallback(fetchedAt: string): AvailabilityResponse {
  return { availabilityByBranch: {}, unassignedCount: 0, totalFree: 0, fleetOccupancy: null, source: "fallback", fetchedAt };
}

/**
 * GET /api/integrations/swhouse/replacement-vehicles
 * Vráti agregát aktuálne voľných náhradných vozidiel per pobočka + ECV sety
 * voľné/obsadené na párovanie stavov vo Flotile (read-only, server-side creds).
 * Pri nekonfigurácii/zlyhaní vendora vráti source:"fallback" (UI ponechá manuálnu hodnotu) — nikdy nepoloží dashboard.
 * Žiadne secret v odpovedi. Dáta sú globálne (nie per-tenant), expozícia rovnaká ako ostatné app routes.
 */
export async function GET() {
  const denied = await motoristAccessGuard();
  if (denied) return denied;

  const fetchedAt = new Date().toISOString();
  try {
    const snapshot = await getReplacementVehicleSnapshot();
    if (!snapshot) {
      return Response.json(fallback(fetchedAt));
    }
    return Response.json({ ...snapshot, source: "swhouse", fetchedAt } satisfies AvailabilityResponse);
  } catch (error) {
    console.error("SWHouse replacement-vehicles route failed:", error);
    return Response.json(fallback(fetchedAt));
  }
}
