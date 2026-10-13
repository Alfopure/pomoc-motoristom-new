import { requireTowingRequestActor } from '@/server/towing/auth';
import { assertTowingOrigin, boundedJson, towingErrorResponse, towingJson, uuid } from '@/server/towing/http';
import { emailTowingDocument } from '@/server/towing/documents';
export const runtime = 'nodejs';
export const maxDuration = 30;
export async function POST(request: Request, context: {params:Promise<{id:string}>}) {
  try { assertTowingOrigin(request); const actor = await requireTowingRequestActor(request,'documents'); const id = uuid((await context.params).id);
    return towingJson(await emailTowingDocument(actor,id,await boundedJson(request)));
  } catch(error) { return towingErrorResponse(error); }
}
