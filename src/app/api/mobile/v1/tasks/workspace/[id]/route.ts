import { getEmployeeTask, requireEmployeeTaskUser } from "@/server/mobile/employee-tasks";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireEmployeeTaskUser(request);
    return mobileJson(await getEmployeeTask(actor, (await context.params).id, new URL(request.url).searchParams));
  } catch (error) { return mobileError(error, "Úlohu sa nepodarilo načítať."); }
}
