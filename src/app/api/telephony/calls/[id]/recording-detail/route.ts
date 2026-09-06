import { recordingRoute } from "@/server/telephony/recording-route";
import { getCallRecordingDetail, deleteOrRetryRecording } from "@/server/telephony/recording-service";
export const runtime = "nodejs";
export const maxDuration = 30;
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) { const { id } = await params; return recordingRoute(request, ({ admin, actor }) => getCallRecordingDetail(admin, actor, id)); }
export async function DELETE(request: Request, { params }: Context) { const { id } = await params; return recordingRoute(request, ({ admin, actor, body }) => deleteOrRetryRecording(admin, actor, id, body, "delete")); }
