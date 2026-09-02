import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { assertSameOriginRequest, requireDefaultMotoristOrgMember, resolveDefaultOrganizationId } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import { materializeDueTaskReminders } from "@/server/task-notifications";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    await authorizeMaterializer(request);

    const organizationId = await resolveDefaultOrganizationId();
    const limit = limitFromUrl(request.url);
    const result = await materializeDueTaskReminders(createSupabaseAdminClient(), organizationId, new Date(), limit);
    return Response.json({ organizationId, ...result });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Notification materialization failed:", error);
    return Response.json({ error: "Notifikácie sa nepodarilo spracovať." }, { status: 500 });
  }
}

async function authorizeMaterializer(request: Request) {
  const secret = process.env.MOTORIST_NOTIFICATIONS_CRON_SECRET?.trim() || process.env.CRON_SECRET?.trim();
  const authorization = request.headers.get("authorization")?.trim();

  if (secret && authorization === `Bearer ${secret}`) {
    return;
  }

  // Len session sub-vetva dostáva CSRF (dual route); bearer cron vetva vyššie ju obchádza (M1, US-103).
  assertSameOriginRequest(request);
  await requireDefaultMotoristOrgMember();
}

function limitFromUrl(url: string) {
  const value = Number(new URL(url).searchParams.get("limit") ?? 50);

  if (!Number.isFinite(value)) {
    return 50;
  }

  return Math.min(200, Math.max(1, Math.trunc(value)));
}
