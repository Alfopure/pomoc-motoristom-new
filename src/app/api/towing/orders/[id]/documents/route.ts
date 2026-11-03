import { requireTowingRequestActor } from '@/server/towing/auth';
import { assertTowingOrigin, boundedJson, towingErrorResponse, towingJson, uuid } from '@/server/towing/http';
import { issueTowingDocument } from '@/server/towing/documents';
import { readTowingFile, towingFileResponse } from '@/server/towing/files';
export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  try { assertTowingOrigin(request); const actor = await requireTowingRequestActor(request,'documents'); const id = uuid((await context.params).id);
    return towingJson(await issueTowingDocument(actor,id,await boundedJson(request)));
  } catch(error) { return towingErrorResponse(error); }
}
export async function GET(request: Request, context: Context) {
  try { const actor = await requireTowingRequestActor(request,'documents'); const id = uuid((await context.params).id);
    const {file,bytes} = await readTowingFile(actor,uuid(new URL(request.url).searchParams.get('documentId')),'document',id); return towingFileResponse(file,bytes);
  } catch(error) { return towingErrorResponse(error); }
}
