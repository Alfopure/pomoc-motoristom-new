import { MOBILE_HANDOFF_MAX_RESPONSE_BYTES } from "@/lib/mobile-api";
import { requireMobileUser } from "@/server/mobile/user";
import { commandMobileCaseHandoff, getMobileCaseHandoffs, readMobileHandoffInput } from "@/server/mobile/case-handoff";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
export const runtime = "nodejs";
const fallback = "Odovzdanie sa nepodarilo overiť. Zachovajte pôvodnú požiadavku; pri príliš veľkom náhľade použite webovú kartu.";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireMobileUser(request, { maxResponseBytes: MOBILE_HANDOFF_MAX_RESPONSE_BYTES });
    const { id } = await context.params;
    return mobileJson({ ...mobileScope(session.actor), ...await getMobileCaseHandoffs(session, id) });
  } catch (error) { return mobileError(error, fallback); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireMobileUser(request, { maxResponseBytes: MOBILE_HANDOFF_MAX_RESPONSE_BYTES });
    const { id } = await context.params;
    const input = await readMobileHandoffInput(request);
    const result = await commandMobileCaseHandoff(session, request, id, input);
    return mobileJson({ ...mobileScope(session.actor), ...result });
  } catch (error) { return mobileError(error, fallback); }
}
