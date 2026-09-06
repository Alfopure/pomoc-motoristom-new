import { recordingRoute } from "@/server/telephony/recording-route";
import { getQualityDashboard } from "@/server/telephony/recording-service";
export const runtime = "nodejs";
export const maxDuration = 30;
export async function GET(request: Request) { return recordingRoute(request, ({ admin, actor }) => getQualityDashboard(admin, actor, new URL(request.url).searchParams)); }
