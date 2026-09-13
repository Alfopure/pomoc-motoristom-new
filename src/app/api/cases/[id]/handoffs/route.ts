import { commandCaseHandoff, getCaseHandoffContext, handoffError, handoffResponse } from "@/server/case-handoff";
export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return handoffResponse(await getCaseHandoffContext((await params).id)); } catch (error) { return handoffError(error); }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return handoffResponse(await commandCaseHandoff(request, (await params).id)); } catch (error) { return handoffError(error); }
}
