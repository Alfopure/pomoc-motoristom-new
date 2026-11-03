import type { MobileTaskTransitioned } from "@/lib/mobile-api";
import { readMobileJsonBody } from "@/server/mobile/body";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { parseMobileTaskWorkflow, transitionMobileTask } from "@/server/mobile/tasks";
import { requireMobileUser } from "@/server/mobile/user";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { actor, client } = await requireMobileUser(request);
    const { id } = await context.params;
    const input = parseMobileTaskWorkflow(await readMobileJsonBody(request));
    const result = await transitionMobileTask(actor, id, input, client);
    const body: MobileTaskTransitioned = { ...mobileScope(actor), ...result };
    return mobileJson(body);
  } catch (error) { return mobileError(error, "Zmenu stavu úlohy sa nepodarilo potvrdiť. Overte tú istú požiadavku."); }
}
