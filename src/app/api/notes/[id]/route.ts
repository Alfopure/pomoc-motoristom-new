import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { deleteNote, loadNote, NOTE_ROLES, noteErrorResponse, noteResponse, readNoteBody, saveNote } from "@/server/notes";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try { const actor = await requireDefaultMotoristActor([...NOTE_ROLES]); return noteResponse({ note: await loadNote(actor, (await context.params).id) }); }
  catch (error) { return noteErrorResponse(error); }
}
export async function PATCH(request: Request, context: Context) {
  try { assertSameOriginRequest(request); const actor = await requireDefaultMotoristActor([...NOTE_ROLES]); return noteResponse({ note: await saveNote(actor, await readNoteBody(request), (await context.params).id) }); }
  catch (error) { return noteErrorResponse(error); }
}
export async function DELETE(request: Request, context: Context) {
  try { assertSameOriginRequest(request); const actor = await requireDefaultMotoristActor([...NOTE_ROLES]); const input = await readNoteBody(request); return noteResponse(await deleteNote(actor, (await context.params).id, input.expectedRevision)); }
  catch (error) { return noteErrorResponse(error); }
}
