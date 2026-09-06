import { recordingRoute } from "@/server/telephony/recording-route";
import { getRecordingPolicy, saveRecordingPolicy } from "@/server/telephony/recording-policy-service";
export const runtime = "nodejs";
export async function GET(request: Request) { return recordingRoute(request, ({ admin, actor }) => getRecordingPolicy(admin, actor)); }
export async function PUT(request: Request) { return recordingRoute(request, ({ admin, actor, body }) => saveRecordingPolicy(admin, actor, body)); }
