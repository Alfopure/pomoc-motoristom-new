import { requireTowingRequestActor } from '@/server/towing/auth';
import { assertTowingOrigin, boundedJson, towingErrorResponse, towingJson } from '@/server/towing/http';
import { manageTowingMembership } from '@/server/towing/memberships';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try { assertTowingOrigin(request); const actor = await requireTowingRequestActor(request,'members');
    return towingJson(await manageTowingMembership(actor,await boundedJson(request,32000)));
  } catch(error) { return towingErrorResponse(error); }
}
