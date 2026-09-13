import { handoffError, handoffResponse, publicHandoff } from "@/server/case-handoff";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try { return handoffResponse(await publicHandoff(request, "command")); } catch (error) { return handoffError(error); }
}
