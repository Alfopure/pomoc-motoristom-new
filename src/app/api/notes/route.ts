import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { loadNotes, NOTE_ROLES, noteErrorResponse, noteResponse, readNoteBody, saveNote } from "@/server/notes";
export const runtime = "nodejs";
export async function GET() {
  try { const actor = await requireDefaultMotoristActor([...NOTE_ROLES]); return noteResponse({ notes: await loadNotes(actor) }); }
  catch (error) { return noteErrorResponse(error); }
}
export async function POST(request: Request) {
  try { assertSameOriginRequest(request); const actor = await requireDefaultMotoristActor([...NOTE_ROLES]); return noteResponse({ note: await saveNote(actor, await readNoteBody(request)) }, 201); }
  catch (error) { return noteErrorResponse(error); }
}
