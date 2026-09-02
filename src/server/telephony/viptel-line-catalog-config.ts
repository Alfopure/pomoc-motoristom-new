import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import { assertTelephonyLiveMutationEnabled } from "./live-mutation-gate";
import { normalizeViptelPublicNumber, VIPTEL_CANONICAL_LINES } from "./viptel-line-catalog";

type LineRow = Pick<
  Database["public"]["Tables"]["motorist_telephony_lines"]["Row"],
  "active" | "external_id" | "id" | "label" | "phone_number"
>;

export type ViptelLineCatalogConfigurationItem = {
  action: "insert" | "update" | "noop" | "conflict";
  existingId?: string;
  label: string;
  phoneNumber: string;
  purpose: (typeof VIPTEL_CANONICAL_LINES)[number]["purpose"];
  reason?: string;
};

export function planViptelLineCatalogConfiguration(
  rows: ReadonlyArray<LineRow>,
): ViptelLineCatalogConfigurationItem[] {
  const indexedRows = rows.map((row) => ({
    row,
    normalizedNumbers: uniqueNormalizedNumbers([row.phone_number, row.external_id]),
  }));

  return VIPTEL_CANONICAL_LINES.map((definition) => {
    const normalized = normalizeViptelPublicNumber(definition.phoneNumber)!;
    const matches = indexedRows.filter(({ normalizedNumbers }) => normalizedNumbers.includes(normalized));

    if (matches.length > 1 || matches.some(({ normalizedNumbers }) => normalizedNumbers.length !== 1)) {
      return {
        action: "conflict",
        label: definition.label,
        phoneNumber: definition.phoneNumber,
        purpose: definition.purpose,
        reason: matches.some(({ normalizedNumbers }) => normalizedNumbers.length > 1)
          ? "Jeden databázový riadok odkazuje na viac rozdielnych verejných čísel."
          : "Viac databázových riadkov reprezentuje rovnaké verejné číslo.",
      };
    }

    const existing = matches[0]?.row;
    if (!existing) {
      return {
        action: "insert",
        label: definition.label,
        phoneNumber: definition.phoneNumber,
        purpose: definition.purpose,
      };
    }

    const exact =
      existing.active &&
      existing.phone_number === definition.phoneNumber &&
      existing.label === definition.label;
    return {
      action: exact ? "noop" : "update",
      existingId: existing.id,
      label: definition.label,
      phoneNumber: definition.phoneNumber,
      purpose: definition.purpose,
    };
  });
}

function uniqueNormalizedNumbers(values: ReadonlyArray<unknown>) {
  return [...new Set(values
    .map(normalizeViptelPublicNumber)
    .filter((value): value is string => Boolean(value)))];
}

export async function configureViptelLineCatalog(actor: MotoristActor, dryRun = true) {
  const supabase = createSupabaseAdminClient();
  const existing = await supabase
    .from("motorist_telephony_lines")
    .select("id, external_id, phone_number, label, active")
    .eq("organization_id", actor.organizationId)
    .eq("provider", "viptel");
  if (existing.error) throw new MutationError("VIPTel katalóg liniek sa nepodarilo načítať.", 500);

  const plan = planViptelLineCatalogConfiguration(existing.data ?? []);
  if (dryRun) return { applied: false as const, plan };
  if (plan.some((item) => item.action === "conflict")) {
    throw new MutationError("VIPTel katalóg obsahuje konfliktné čísla. Apply ostáva zablokovaný.", 409);
  }

  assertTelephonyLiveMutationEnabled("dispatch.lines.catalog.apply");
  for (const item of plan) {
    if (item.action === "noop") continue;
    if (item.action === "insert") {
      const inserted = await supabase.from("motorist_telephony_lines").insert({
        organization_id: actor.organizationId,
        provider: "viptel",
        external_id: item.phoneNumber,
        phone_number: item.phoneNumber,
        label: item.label,
        active: true,
        metadata: toJson({ dispatchCatalog: true, purpose: item.purpose }),
      });
      if (inserted.error) throw new MutationError(`Linku ${item.phoneNumber} sa nepodarilo vytvoriť.`, 500);
      continue;
    }

    const updated = await supabase
      .from("motorist_telephony_lines")
      .update({
        phone_number: item.phoneNumber,
        label: item.label,
        active: true,
      })
      .eq("id", item.existingId as string)
      .eq("organization_id", actor.organizationId);
    if (updated.error) throw new MutationError(`Linku ${item.phoneNumber} sa nepodarilo aktualizovať.`, 500);
  }

  const audit = await supabase.from("motorist_audit_log").insert({
    organization_id: actor.organizationId,
    actor_profile_id: actor.profileId,
    action: "telephony.lines.catalog.apply",
    entity_type: "motorist_telephony_lines",
    entity_id: null,
    source: "web",
    before_payload: null,
    after_payload: toJson({
      lines: plan.map(({ action, label, phoneNumber, purpose }) => ({ action, label, phoneNumber, purpose })),
    }),
  });
  if (audit.error) throw new MutationError("Katalóg sa zapísal, ale audit zlyhal. Pred opakovaním treba obnoviť dry-run a skontrolovať aktuálny stav.", 500);

  return { applied: true as const, plan };
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}
