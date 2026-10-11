import type { MobileTaskMessages, MobileTaskMessageSent } from "@/lib/mobile-api";
import { readMobileJsonBody } from "@/server/mobile/body";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { listMobileTaskMessages, parseMobileTaskMessage, sendMobileTaskMessage } from "@/server/mobile/tasks";
import { requireMobileUser } from "@/server/mobile/user";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { actor, client } = await requireMobileUser(request);
    const { id } = await context.params;
    const result = await listMobileTaskMessages(actor, id, new URL(request.url).searchParams, client);
    const body: MobileTaskMessages = { ...mobileScope(actor), ...result };
    return mobileJson(body);
  } catch (error) { return mobileError(error, "Správy k úlohe sa nepodarilo načítať."); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { actor, client } = await requireMobileUser(request);
    const { id } = await context.params;
    const input = parseMobileTaskMessage(await readMobileJsonBody(request));
    const result = await sendMobileTaskMessage(actor, id, input, client);
    const body: MobileTaskMessageSent = { ...mobileScope(actor), ...result };
    return mobileJson(body, 201);
  } catch (error) { return mobileError(error, "Správu sa nepodarilo potvrdiť. Overte tú istú správu znova."); }
}
