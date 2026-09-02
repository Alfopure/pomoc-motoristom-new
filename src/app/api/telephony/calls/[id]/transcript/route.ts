import { requireDefaultMotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const TRANSCRIPT_ACCESS_ROLES = ["senior_dispatcher", "manager", "admin"] as const;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireDefaultMotoristActor([...TRANSCRIPT_ACCESS_ROLES]);
    const { id } = await params;
    const supabase = createSupabaseAdminClient();

    const transcript = await supabase
      .from("motorist_call_transcripts")
      .select("id, recording_id, status, language, model, transcript_text, speaker_segments, summary, extracted_fields, qa_score, updated_at")
      .eq("organization_id", actor.organizationId)
      .eq("call_id", id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (transcript.error) {
      throw new MutationError(transcript.error.message, 500);
    }

    if (!transcript.data) {
      return Response.json({ found: false });
    }

    const fields = asRecord(transcript.data.extracted_fields);

    return Response.json({
      found: true,
      transcriptId: transcript.data.id,
      recordingId: transcript.data.recording_id,
      status: transcript.data.status,
      language: transcript.data.language,
      model: transcript.data.model,
      text: transcript.data.transcript_text,
      segments: Array.isArray(transcript.data.speaker_segments) ? transcript.data.speaker_segments : [],
      summary: transcript.data.summary,
      extractedFields: {
        spz: stringOrNull(fields.spz),
        lokalita: stringOrNull(fields.lokalita),
        typ_poruchy: stringOrNull(fields.typ_poruchy),
        dohodnuty_krok: stringOrNull(fields.dohodnuty_krok),
        telefon: stringOrNull(fields.telefon),
      },
      qaScore: transcript.data.qa_score,
      qaBreakdown: fields.qa_breakdown && typeof fields.qa_breakdown === "object" ? fields.qa_breakdown : null,
      qaNotes: Array.isArray(fields.qa_notes) ? fields.qa_notes : [],
      qaGated: fields.qa_gated === true,
      updatedAt: transcript.data.updated_at,
    });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Prepis sa nepodarilo načítať.";
    return Response.json({ error: message }, { status: 500 });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}
