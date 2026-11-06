import { readMobileJsonBody } from "@/server/mobile/body";
import { createEmployeeTask, listEmployeeTasks, requireEmployeeTaskUser } from "@/server/mobile/employee-tasks";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await requireEmployeeTaskUser(request);
    return mobileJson(await listEmployeeTasks(actor, new URL(request.url).searchParams));
  } catch (error) { return mobileError(error, "Úlohy sa nepodarilo načítať."); }
}
export async function POST(request: Request) {
  try {
    const actor = await requireEmployeeTaskUser(request);
    return mobileJson(await createEmployeeTask(actor, await readMobileJsonBody(request)), 201);
  } catch (error) { return mobileError(error, "Vytvorenie úlohy sa nepodarilo potvrdiť. Overte pôvodnú požiadavku."); }
}
