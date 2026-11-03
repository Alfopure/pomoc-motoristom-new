import type { MobileCaseTasks, MobileTaskCreated } from "@/lib/mobile-api";
import { readMobileJsonBody } from "@/server/mobile/body";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { createMobileTask, listMobileCaseTasks, parseMobileTaskCreate, parseMobileTaskQuery } from "@/server/mobile/tasks";
import { requireMobileUser } from "@/server/mobile/user";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { actor, client } = await requireMobileUser(request);
    const { id } = await context.params;
    const result = await listMobileCaseTasks(actor, id, parseMobileTaskQuery(new URL(request.url).searchParams), client);
    const body: MobileCaseTasks = { ...mobileScope(actor), ...result };
    return mobileJson(body);
  } catch (error) { return mobileError(error, "Úlohy prípadu sa nepodarilo načítať."); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { actor, client } = await requireMobileUser(request);
    const { id } = await context.params;
    const input = parseMobileTaskCreate(await readMobileJsonBody(request));
    const result = await createMobileTask(actor, id, input, client);
    const body: MobileTaskCreated = { ...mobileScope(actor), ...result };
    return mobileJson(body, 201);
  } catch (error) { return mobileError(error, "Uloženie úlohy sa nepodarilo potvrdiť. Pred ďalším pokusom skontrolujte zoznam."); }
}
