import { recordingRoute } from "@/server/telephony/recording-route";
import { getCallRecordingDetail, recordingError, requireRecordingSource } from "@/server/telephony/recording-service";
import { createTelephonyDeps, toCallActor } from "@/server/telephony/runtime";
import { stopCallRecording } from "@/server/telephony/call-actions";
export const runtime = "nodejs";
export const maxDuration = 30;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
 const { id } = await params;
 return recordingRoute(request, async ({ admin, actor, body }) => {
   if (body.action !== "stop" && body.action !== "retry_stop") recordingError("Neplatný pokyn nahrávania.");
   const rows = await requireRecordingSource(admin, actor, id);
   if (!rows.call.session_id || rows.call.ended_at) recordingError("Hovor už nie je aktívny.", 409);
   const deps = await createTelephonyDeps();
   if (deps.organizationId !== actor.organizationId) recordingError("Na hovor nemáš oprávnenie.", 403);
   await stopCallRecording(deps, toCallActor(actor), rows.call.session_id, body.action === "retry_stop");
   return getCallRecordingDetail(admin, actor, id);
 });
}
