import type { MobileCaseNoteAdded } from "@/lib/mobile-api";
import { requireMobileActor } from "@/server/mobile/auth";
import { addMobileCaseNote, readMobileCaseNote } from "@/server/mobile/case-notes";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileActor(request);
    const { id } = await context.params;
    const result = await addMobileCaseNote(actor, id, await readMobileCaseNote(request), request.signal);
    const body: MobileCaseNoteAdded = { ...mobileScope(actor), ...result };
    return mobileJson(body, 201);
  } catch (error) { return mobileError(error, "Výsledok poznámky sa nepodarilo overiť. Overte tú istú požiadavku."); }
}
