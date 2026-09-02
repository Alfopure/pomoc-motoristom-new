import { loadDispatchData } from "@/data/dispatch-repository";
import { assertSameOriginRequest, requireDefaultMotoristOrgRole } from "@/server/api-auth";
import { syncCommander } from "@/server/integrations/commander/sync";
import { syncSwhouseFleet } from "@/server/integrations/swhouse/sync";
import { autoConfirmCommanderLinks, MutationError } from "@/server/motorist-mutations";

export const runtime = "nodejs";
// Commander (vozidlá + polohy) + SWHouse roster + auto-párovanie môže trvať desiatky sekúnd.
export const maxDuration = 300;

/**
 * „Obnoviť dáta" z párovacieho panela: stiahne aktuálny stav z Commandera aj SWHouse a automaticky spáruje,
 * čo sa dá (napr. keď v Commanderi opravili ŠPZ). Vráti čerstvé dispatchData + súhrn. Same-origin + manager/admin.
 */
export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    await requireDefaultMotoristOrgRole(["manager", "admin"]);
  } catch (error) {
    // Zachovaj MutationError status: CSRF mismatch → 403, neprihlásený → 401 (M1, US-103).
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "Na túto operáciu sa musíš prihlásiť ako správca." }, { status: 401 });
  }

  const summary = { commanderVehicles: false, commanderPositions: false, swhouse: false, autoPaired: 0, warnings: [] as string[] };

  try {
    const vehicles = await syncCommander({ mode: "vehicles" });
    summary.commanderVehicles = vehicles.status !== "failed";
    if (vehicles.status === "failed") {
      summary.warnings.push("Commander vozidlá sa nepodarilo obnoviť.");
    }
  } catch {
    summary.warnings.push("Commander vozidlá sa nepodarilo obnoviť.");
  }

  try {
    const positions = await syncCommander({ mode: "positions" });
    summary.commanderPositions = positions.status !== "failed";
    if (positions.status === "failed") {
      summary.warnings.push("Commander polohy sa nepodarilo obnoviť.");
    }
  } catch {
    summary.warnings.push("Commander polohy sa nepodarilo obnoviť.");
  }

  try {
    const swhouse = await syncSwhouseFleet({});
    summary.swhouse = swhouse.status !== "failed";
    if (swhouse.status === "failed") {
      summary.warnings.push("SWHouse sa nepodarilo obnoviť.");
    }
  } catch {
    summary.warnings.push("SWHouse sa nepodarilo obnoviť.");
  }

  try {
    const result = await autoConfirmCommanderLinks();
    summary.autoPaired = result.autoPaired;
  } catch (error) {
    summary.warnings.push(error instanceof MutationError ? error.message : "Automatické párovanie zlyhalo.");
  }

  const dispatchData = await loadDispatchData();
  return Response.json({ dispatchData, summary });
}
