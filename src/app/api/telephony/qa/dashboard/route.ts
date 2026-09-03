import { requireDefaultMotoristActor } from "@/server/api-auth";
import { createTelephonyDeps, telephonyErrorResponse } from "@/server/telephony/runtime";
import { loadQaDashboard } from "@/server/telephony/qa";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QA_ACCESS_ROLES = ["senior_dispatcher", "manager", "admin"] as const;

/**
 * Quality of service without audio (plan "Fáza 4", QA bez prepisov).
 *
 * This route used to average `motorist_call_transcripts.qa_score`. That table is
 * never written in this copy — recording and transcription are out of scope —
 * so it answered `totalScored: 0` and the panel hid itself. It now reports the
 * two things the application does record: how many finished calls carry an
 * outcome, and whether the callbacks we promised were made in time.
 *
 * The role stays senior dispatcher and above: these numbers name individual
 * dispatchers.
 */
export async function GET() {
  try {
    const actor = await requireDefaultMotoristActor([...QA_ACCESS_ROLES]);
    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    const payload = await loadQaDashboard({ admin: deps.admin, organizationId: deps.organizationId, now: deps.now });
    return Response.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return telephonyErrorResponse(error, "QA prehľad sa nepodarilo načítať.");
  }
}
