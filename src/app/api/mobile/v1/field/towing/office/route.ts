import { fieldScope, requireMobileMember } from '@/server/mobile/field-auth';
import { asMobileError } from '@/server/mobile/field-work';
import { mobileError, mobileJson } from '@/server/mobile/http';
import { loadMobileTowingOffice } from '@/server/mobile/towing-office';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const actor = await requireMobileMember(request);
    return mobileJson({ ...fieldScope(actor), workspace: await loadMobileTowingOffice(actor, new URL(request.url)) });
  } catch (error) { return mobileError(asMobileError(error), 'Odťahovú kanceláriu sa nepodarilo načítať.'); }
}
