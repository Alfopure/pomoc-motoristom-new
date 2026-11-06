import { readMobileJsonBody } from "@/server/mobile/body";
import { requireEmployeeTaskUser } from "@/server/mobile/employee-tasks";
import { mobileError, mobileJson } from "@/server/mobile/http";
import { prepareTaskAttachment } from "@/server/mobile/task-photos";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const actor = await requireEmployeeTaskUser(request); return mobileJson(await prepareTaskAttachment(actor, (await context.params).id, await readMobileJsonBody(request)), 201); }
  catch (error) { return mobileError(error, "Fotografiu sa nepodarilo pripraviť."); }
}
