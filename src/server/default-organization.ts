import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { MutationError } from "@/server/mutation-error";

const DEFAULT_ORGANIZATION_SLUG = "pomoc-motoristom";

export async function resolveDefaultOrganizationId() {
  const slug = process.env.MOTORIST_ORGANIZATION_SLUG?.trim() || DEFAULT_ORGANIZATION_SLUG;
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.from("motorist_organizations").select("id").eq("slug", slug).eq("active", true).maybeSingle();

  if (error) {
    throw new MutationError("Organizáciu sa nepodarilo overiť.", 500);
  }

  if (!data) {
    throw new MutationError("Organizácia nie je nakonfigurovaná.", 500);
  }

  return data.id;
}
