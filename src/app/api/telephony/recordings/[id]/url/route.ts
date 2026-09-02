import { requireDefaultMotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { RECORDINGS_BUCKET } from "@/server/telephony/recordings-sync";

export const runtime = "nodejs";

const SIGNED_URL_TTL_SECONDS = 300;
const RECORDING_ACCESS_ROLES = ["senior_dispatcher", "manager", "admin"] as const;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireDefaultMotoristActor([...RECORDING_ACCESS_ROLES]);
    const { id } = await params;
    const supabase = createSupabaseAdminClient();

    const recording = await supabase
      .from("motorist_call_recordings")
      .select("id, call_id, status, storage_bucket, storage_path, mime_type, duration_seconds")
      .eq("organization_id", actor.organizationId)
      .eq("id", id)
      .maybeSingle();

    if (recording.error) {
      throw new MutationError(recording.error.message, 500);
    }

    if (!recording.data || recording.data.status !== "available" || !recording.data.storage_path) {
      throw new MutationError("Nahrávka nie je k dispozícii.", 404);
    }

    const signed = await supabase.storage
      .from(recording.data.storage_bucket ?? RECORDINGS_BUCKET)
      .createSignedUrl(recording.data.storage_path, SIGNED_URL_TTL_SECONDS);

    if (signed.error || !signed.data?.signedUrl) {
      throw new MutationError(signed.error?.message ?? "Podpísanú URL sa nepodarilo vytvoriť.", 500);
    }

    // Every URL issue is auditable: recordings are sensitive personal data.
    const audit = await supabase.from("motorist_audit_log").insert({
      organization_id: actor.organizationId,
      actor_profile_id: actor.profileId,
      action: "recording.url_issued",
      entity_type: "motorist_call_recordings",
      entity_id: recording.data.id,
      source: "dispatch_console",
      after_payload: { call_id: recording.data.call_id, ttl_seconds: SIGNED_URL_TTL_SECONDS },
    });

    if (audit.error) {
      throw new MutationError(`Audit zápis zlyhal: ${audit.error.message}`, 500);
    }

    return Response.json({
      signedUrl: signed.data.signedUrl,
      expiresInSeconds: SIGNED_URL_TTL_SECONDS,
      mimeType: recording.data.mime_type ?? "audio/mpeg",
      durationSeconds: recording.data.duration_seconds,
    });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Nepodarilo sa vydať URL nahrávky.";
    return Response.json({ error: message }, { status: 500 });
  }
}
