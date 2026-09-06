import { recordingRoute } from "@/server/telephony/recording-route";
import { approveCallQuality } from "@/server/telephony/recording-service";
export const runtime = "nodejs";
export const maxDuration = 30;
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, { params }: Context) { const { id } = await params; return recordingRoute(request, ({ admin, actor, body }) => approveCallQuality(admin, actor, id, body)); }
