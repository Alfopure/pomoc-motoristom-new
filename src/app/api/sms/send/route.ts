import { withRequestMetrics } from "@/server/request-metrics";
import { postSms } from "@/server/sms-http";
export const runtime = "nodejs";
export async function POST(request: Request) { return withRequestMetrics("sms.send", () => postSms(request)); }
