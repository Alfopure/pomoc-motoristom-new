import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { MutationError } from "@/server/mutation-error";

const DEFAULT_ORGANIZATION_SLUG = "pomoc-motoristom";

/**
 * A slug maps to the same organisation row for the life of an instance, but
 * every telephony request — each webhook, each control, each 750 ms poll —
 * used to look it up again before doing any work. Only successful lookups are
 * remembered, so a misconfiguration still reports itself on the next request.
 */
const resolvedBySlug = new Map<string, string>();

export function forgetResolvedOrganizations(): void {
  resolvedBySlug.clear();
}

export async function resolveDefaultOrganizationId() {
  const slug = process.env.MOTORIST_ORGANIZATION_SLUG?.trim() || DEFAULT_ORGANIZATION_SLUG;
  const cached = resolvedBySlug.get(slug);
  if (cached) return cached;
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.from("motorist_organizations").select("id").eq("slug", slug).eq("active", true).maybeSingle();

  if (error) {
    throw new MutationError("Organizáciu sa nepodarilo overiť.", 500);
  }

  if (!data) {
    throw new MutationError("Organizácia nie je nakonfigurovaná.", 500);
  }

  resolvedBySlug.set(slug, data.id);
  return data.id;
}
