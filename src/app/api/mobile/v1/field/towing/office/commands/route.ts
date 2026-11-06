import { readMobileJsonBody } from '@/server/mobile/body';
import { fieldScope, requireMobileMember } from '@/server/mobile/field-auth';
import { asMobileError } from '@/server/mobile/field-work';
import { mobileError, mobileJson } from '@/server/mobile/http';
import { commandMobileTowingOffice } from '@/server/mobile/towing-office';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const actor = await requireMobileMember(request);
    return mobileJson({ ...fieldScope(actor), ...await commandMobileTowingOffice(actor, await readMobileJsonBody(request)) });
  } catch (error) { return mobileError(asMobileError(error), 'Krok sa nepodarilo potvrdiť. Overte rovnaké zadanie.'); }
}
