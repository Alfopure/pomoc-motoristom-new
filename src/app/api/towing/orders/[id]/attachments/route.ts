import { requireTowingRequestActor } from '@/server/towing/auth';
import { assertTowingOrigin, towingErrorResponse, towingJson, uuid } from '@/server/towing/http';
import { readTowingFile, towingFileResponse, uploadTowingAttachment } from '@/server/towing/files';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  try { assertTowingOrigin(request); const actor = await requireTowingRequestActor(request); const id = uuid((await context.params).id);
    return towingJson(await uploadTowingAttachment(actor,id,request));
  } catch(error) { return towingErrorResponse(error); }
}
export async function GET(request: Request, context: Context) {
  try { const actor = await requireTowingRequestActor(request); const id = uuid((await context.params).id); const attachmentId = uuid(new URL(request.url).searchParams.get('attachmentId'));
    const {file,bytes} = await readTowingFile(actor,attachmentId,'attachment',id); return towingFileResponse(file,bytes);
  } catch(error) { return towingErrorResponse(error); }
}
