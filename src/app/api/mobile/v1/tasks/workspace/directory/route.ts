import { directoryEmployeeTasks, requireEmployeeTaskUser } from "@/server/mobile/employee-tasks";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await requireEmployeeTaskUser(request);
    return mobileJson(await directoryEmployeeTasks(actor, new URL(request.url).searchParams));
  } catch (error) { return mobileError(error, "Kolegov a pobočky sa nepodarilo načítať."); }
}
