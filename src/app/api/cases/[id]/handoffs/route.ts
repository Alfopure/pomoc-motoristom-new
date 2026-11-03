import { commandWebCaseHandoff, getWebCaseHandoffContext } from "@/server/web-case-handoff";
import { handoffError, handoffResponse } from "@/server/case-handoff";
export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return handoffResponse(await getWebCaseHandoffContext((await params).id)); } catch (error) { return handoffError(error); }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return handoffResponse(await commandWebCaseHandoff(request, (await params).id)); } catch (error) { return handoffError(error); }
}
