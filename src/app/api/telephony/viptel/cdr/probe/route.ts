import { authorizeRecordingsSync } from "@/server/telephony/sync-auth";

export const runtime = "nodejs";

// VIPTel REST is IP-allowlisted to the always-on Hetzner host. CDR downloads are
// intentionally not proxied through the bounded live-state snapshot bridge.
export async function GET(request: Request) {
  const auth = authorizeRecordingsSync(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  return Response.json({
    ok: false,
    error: "VIPTel CDR probe je dostupný iba ako jednorazová úloha na povolenom Hetzner hoste.",
    executionTarget: "hetzner_one_shot",
  }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
}
