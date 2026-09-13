import { handoffError, handoffResponse, publicHandoff } from "@/server/case-handoff";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { return handoffResponse(await publicHandoff(request, "read")); } catch (error) { return handoffError(error); }
}
