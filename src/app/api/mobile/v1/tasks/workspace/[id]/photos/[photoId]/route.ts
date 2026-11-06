import { readMobileJsonBody } from "@/server/mobile/body";
import { requireEmployeeTaskUser } from "@/server/mobile/employee-tasks";
import { mobileError, mobileJson } from "@/server/mobile/http";
import { downloadTaskAttachment, removeTaskAttachment } from "@/server/mobile/task-photos";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; photoId: string }> };
export async function GET(request: Request, context: Context) {
  try { const actor = await requireEmployeeTaskUser(request), { id, photoId } = await context.params; return mobileJson(await downloadTaskAttachment(actor, id, photoId)); }
  catch (error) { return mobileError(error, "Fotografiu sa nepodarilo otvoriť."); }
}
export async function DELETE(request: Request, context: Context) {
  try { const actor = await requireEmployeeTaskUser(request), { id, photoId } = await context.params; return mobileJson(await removeTaskAttachment(actor, id, photoId, await readMobileJsonBody(request))); }
  catch (error) { return mobileError(error, "Odstránenie fotografie sa nepodarilo potvrdiť."); }
}
