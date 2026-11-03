import { requireMobileActor } from "@/server/mobile/auth";
import { addMobileCaseAttachment, listMobileCaseAttachments, readMobileCaseAttachment } from "@/server/mobile/case-attachments";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileActor(request), { id } = await context.params;
    return mobileJson({ ...mobileScope(actor), ...await listMobileCaseAttachments(actor, id, request.signal) });
  } catch (error) { return mobileError(error, "Prílohy sa nepodarilo načítať."); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileActor(request), { id } = await context.params;
    return mobileJson({ ...mobileScope(actor), ...await addMobileCaseAttachment(actor, id, await readMobileCaseAttachment(request), request.signal) }, 201);
  } catch (error) { return mobileError(error, "Výsledok prílohy sa nepodarilo potvrdiť. Overte tú istú požiadavku."); }
}
