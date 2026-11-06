import { fieldScope, requireMobileMember } from '@/server/mobile/field-auth';
import { asMobileError } from '@/server/mobile/field-work';
import { mobileError, mobileJson } from '@/server/mobile/http';
import { readMobileTowingOfficeOrder } from '@/server/mobile/towing-office';

export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileMember(request);
    return mobileJson({ ...fieldScope(actor), order: await readMobileTowingOfficeOrder(actor, (await context.params).id) });
  } catch (error) { return mobileError(asMobileError(error), 'Odťah sa nepodarilo načítať.'); }
}
