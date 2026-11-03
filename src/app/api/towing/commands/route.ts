import { requireTowingRequestActor } from '@/server/towing/auth';
import { assertTowingOrigin, boundedJson, towingErrorResponse, towingJson } from '@/server/towing/http';
import { executeTowingCommand, parseTowingCommand } from '@/server/towing/service';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try { assertTowingOrigin(request); const actor = await requireTowingRequestActor(request);
    return towingJson(await executeTowingCommand(actor, parseTowingCommand(await boundedJson(request))));
  } catch (error) { return towingErrorResponse(error); }
}
