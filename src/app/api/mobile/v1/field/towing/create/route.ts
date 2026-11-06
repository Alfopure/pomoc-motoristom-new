import { readMobileJsonBody } from '@/server/mobile/body';
import { fieldScope, requireMobileMember } from '@/server/mobile/field-auth';
import { asMobileError } from '@/server/mobile/field-work';
import { mobileError, mobileJson } from '@/server/mobile/http';
import { createMobileTowingOrder } from '@/server/mobile/towing-office';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const actor = await requireMobileMember(request);
    return mobileJson({ ...fieldScope(actor), ...await createMobileTowingOrder(actor, await readMobileJsonBody(request)) });
  } catch (error) { return mobileError(asMobileError(error), 'Vytvorenie odťahu sa nepodarilo potvrdiť. Overte rovnaké zadanie.'); }
}
