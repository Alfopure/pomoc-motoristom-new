import { recordingRoute } from "@/server/telephony/recording-route";
import { correctCallTranscript, getCallRecordingDetail, recordingError } from "@/server/telephony/recording-service";
export const runtime = "nodejs";
export const maxDuration = 30;
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) {
 const { id } = await params;
 return recordingRoute(request, async ({ admin, actor }) => {
   const detail = await getCallRecordingDetail(admin, actor, id);
   if (detail.access !== "full") recordingError("Na prepis nemáš oprávnenie.", 403);
   const transcript = detail.transcript;
   return { found: transcript.spans.length > 0, status: transcript.status, language: transcript.language,
     text: transcript.spans.map((s) => s.text).join(" "), segments: transcript.spans, summary: detail.analysis?.summary ?? null,
     qaScore: null, qaBreakdown: null, qaNotes: [], qaGated: true, extractedFields: {} };
 });
}
export async function PATCH(request: Request, { params }: Context) {
 const { id } = await params; return recordingRoute(request, ({ admin, actor, body }) => correctCallTranscript(admin, actor, id, body));
}
