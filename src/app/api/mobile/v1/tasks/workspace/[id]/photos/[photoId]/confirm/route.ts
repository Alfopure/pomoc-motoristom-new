import { readMobileJsonBody } from "@/server/mobile/body";
import { requireEmployeeTaskUser } from "@/server/mobile/employee-tasks";
import { mobileError, mobileJson } from "@/server/mobile/http";
import { confirmTaskAttachment } from "@/server/mobile/task-photos";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string; photoId: string }> }) {
  try { const actor = await requireEmployeeTaskUser(request), { id, photoId } = await context.params; return mobileJson(await confirmTaskAttachment(actor, id, photoId, await readMobileJsonBody(request))); }
  catch (error) { return mobileError(error, "Uloženie fotografie sa nepodarilo potvrdiť."); }
}
