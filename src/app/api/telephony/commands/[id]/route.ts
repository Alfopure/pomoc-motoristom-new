import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { MutationError } from "@/server/motorist-mutations";
import { requireTelephonyActor } from "@/server/telephony-access";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireTelephonyActor();
    const { id } = await context.params;
    if (!isUuid(id)) {
      throw new MutationError("Telefónny príkaz nemá platný identifikátor.", 400);
    }

    const result = await createSupabaseAdminClient()
      .from("motorist_telephony_commands")
      .select("id, command_type, status, provider_response, confirmed_at, updated_at")
      .eq("id", id)
      .eq("organization_id", actor.organizationId)
      .eq("requested_by", actor.profileId)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) throw new MutationError("Telefónny príkaz sa nenašiel.", 404);

    const providerResponse = asRecord(result.data.provider_response);
    return Response.json({
      ok: true,
      command: {
        id: result.data.id,
        commandType: result.data.command_type,
        status: result.data.status,
        error: readString(providerResponse.error),
        deliveryUncertain: providerResponse.deliveryUncertain === true,
        confirmedAt: result.data.confirmed_at ?? undefined,
        updatedAt: result.data.updated_at,
      },
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const status = error instanceof MutationError ? error.status : 500;
    return Response.json({
      ok: false,
      error: error instanceof MutationError ? error.message : "Stav telefónneho príkazu sa nepodarilo načítať.",
    }, { status });
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
