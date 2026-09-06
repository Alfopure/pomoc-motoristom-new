import { recordingRoute } from "@/server/telephony/recording-route";
import { getRecordingAudio } from "@/server/telephony/recording-audio";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request, { params }: { params: Promise<{ id: string; recordingId: string }> }) {
 const { id, recordingId } = await params;
 return recordingRoute(request, ({ admin, actor }) => getRecordingAudio(admin, actor, id, recordingId, request));
}
