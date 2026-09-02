import { authorizeRecordingsSync } from "@/server/telephony/sync-auth";

export const runtime = "nodejs";

// This Vercel route remains as an authenticated fail-closed compatibility
// endpoint. The actual job must run on the IP-allowlisted Hetzner runtime.
export async function POST(request: Request) {
  const auth = authorizeRecordingsSync(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  return Response.json({
    error: "Synchronizáciu VIPTel nahrávok spusti ako jednorazovú úlohu na povolenom Hetzner hoste.",
    executionTarget: "hetzner_one_shot",
  }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
}
