import { requireDefaultMotoristActor } from "@/server/api-auth";
import { loadNoteColleagues, NOTE_ROLES, noteErrorResponse, noteResponse } from "@/server/notes";
export const runtime = "nodejs";
export async function GET() {
  try { const actor = await requireDefaultMotoristActor([...NOTE_ROLES]); return noteResponse({ colleagues: await loadNoteColleagues(actor) }); }
  catch (error) { return noteErrorResponse(error); }
}
