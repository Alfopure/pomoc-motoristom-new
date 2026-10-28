import { getRentalDraftPreview } from '@/server/integrations/swhouse/rental-draft';
import { towingErrorResponse, towingJson } from '@/server/towing/http';
type Context = { params: Promise<{ id: string }> };
export const dynamic = 'force-dynamic';
/** Read-only preview; nothing is sent to the rental system yet. */
export async function GET(_request: Request, context: Context) {
  try { return towingJson(await getRentalDraftPreview((await context.params).id)); }
  catch (error) { return towingErrorResponse(error); }
}
