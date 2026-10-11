import { requireMobileActor } from "@/server/mobile/auth";
import { downloadMobileCaseAttachment } from "@/server/mobile/case-attachments";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string; attachmentId: string }> }) {
  try {
    const actor = await requireMobileActor(request), { id, attachmentId } = await context.params;
    return mobileJson({ ...mobileScope(actor), ...await downloadMobileCaseAttachment(actor, id, attachmentId, request.signal) });
  } catch (error) { return mobileError(error, "Súbor sa nepodarilo sprístupniť."); }
}
