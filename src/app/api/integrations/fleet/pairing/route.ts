import { loadDispatchData } from "@/data/dispatch-repository";
import { assertSameOriginRequest, requireDefaultMotoristOrgRole } from "@/server/api-auth";
import { assignCommanderToSwhouseCar, decommissionGhostAsset, MutationError } from "@/server/motorist-mutations";

export const runtime = "nodejs";

type PairingAction =
  | { action: "assign"; commanderRecordId: string; swhouseAssetId: string }
  | { action: "markSold"; assetId: string };

/**
 * Ručné akcie párovacieho panela:
 * - assign: priradí Commander vozidlo k SWHouse autu (presunie polohu, odstráni duplicitu),
 * - markSold: označí ducha ako predané/vyradené (odstráni z flotily).
 * Same-origin + manager/admin.
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Neplatný JSON." }, { status: 400 });
  }

  const input = body as PairingAction;
  try {
    let result: unknown;
    if (input.action === "assign") {
      result = await assignCommanderToSwhouseCar({ commanderRecordId: input.commanderRecordId, swhouseAssetId: input.swhouseAssetId });
    } else if (input.action === "markSold") {
      result = await decommissionGhostAsset({ assetId: input.assetId });
    } else {
      return Response.json({ error: "Neznáma akcia." }, { status: 400 });
    }

    const dispatchData = await loadDispatchData();
    return Response.json({ dispatchData, result });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Pairing action failed:", error);
    return Response.json({ error: "Akciu sa nepodarilo vykonať." }, { status: 500 });
  }
}
