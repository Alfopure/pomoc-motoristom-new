import { postSms } from "@/server/sms-http";
export const runtime = "nodejs";
export async function POST(request: Request) { return postSms(request); }
