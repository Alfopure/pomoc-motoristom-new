import { postSms } from "@/server/sms-http";
export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return postSms(request, (await params).id);
}
