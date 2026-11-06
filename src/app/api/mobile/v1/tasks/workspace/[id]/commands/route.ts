import { readMobileJsonBody } from "@/server/mobile/body";
import { commandEmployeeTask, requireEmployeeTaskUser } from "@/server/mobile/employee-tasks";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireEmployeeTaskUser(request);
    return mobileJson(await commandEmployeeTask(actor, (await context.params).id, await readMobileJsonBody(request)));
  } catch (error) { return mobileError(error, "Krok úlohy sa nepodarilo potvrdiť. Overte pôvodnú požiadavku."); }
}
