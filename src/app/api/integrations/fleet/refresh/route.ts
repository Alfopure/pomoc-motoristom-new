import { loadDispatchData } from "@/data/dispatch-repository";
import { motoristAccessGuard } from "@/server/api-auth";
import { refreshFleetSources } from "@/server/integrations/fleet-refresh";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  // Operators may request vendor reads. Manual linking stays manager/admin only.
  const denied = await motoristAccessGuard({ request });
  if (denied) return denied;
  try {
    const summary = await refreshFleetSources();
    return Response.json({ dispatchData: await loadDispatchData(), summary }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Flotilu sa nepodarilo obnoviť. Posledné uložené údaje zostávajú zachované." }, { status: 503 });
  }
}
