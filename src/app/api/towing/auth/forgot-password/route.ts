import { assertTowingOrigin, boundedJson, towingErrorResponse, towingJson, TowingError } from '@/server/towing/http';
import { sendTowingForgotPassword, towingForgotResult } from '@/server/towing/memberships';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try { assertTowingOrigin(request); const input = await boundedJson(request,4000); await sendTowingForgotPassword(input.email,request); }
  catch(error) { if (error instanceof TowingError && error.code === 'origin_rejected') return towingErrorResponse(error); }
  return towingJson(towingForgotResult());
}
