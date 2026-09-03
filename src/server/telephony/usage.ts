import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

/**
 * Daily telephony usage (`motorist_telephony_daily_usage`) and the spend cap
 * (`motorist_telephony_settings.daily_leg_soft_cap`).
 *
 * Every billable leg (a Telnyx `dial`, including transfer/consult targets) and
 * every SMS send is counted through the `motorist_telephony_usage_add` RPC,
 * which upserts atomically. Counting is best effort: a bookkeeping failure must
 * never break a call in progress. The cap is enforced only on operator-initiated
 * outbound legs — an inbound caller is never refused because of it.
 */

type AdminClient = SupabaseClient<Database>;

export const DEFAULT_DAILY_LEG_SOFT_CAP = 500;

/** `YYYY-MM-DD` in Europe/Bratislava, the billing day the runbook uses. */
export function usageDay(now: Date, timeZone = "Europe/Bratislava"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export type UsageDelta = { legs?: number; minutes?: number; sms?: number };

/** Adds usage for today; returns the new leg count, or null when the write failed. */
export async function addTelephonyUsage(
  admin: AdminClient,
  input: { organizationId: string; now?: Date; logger?: (entry: Record<string, unknown>) => void } & UsageDelta,
): Promise<number | null> {
  const now = input.now ?? new Date();
  const { data, error } = await admin.rpc("motorist_telephony_usage_add", {
    p_organization_id: input.organizationId,
    p_day: usageDay(now),
    p_legs: input.legs ?? 0,
    p_minutes: input.minutes ?? 0,
    p_sms: input.sms ?? 0,
  });
  if (error) {
    input.logger?.({ level: "warn", scope: "usage", message: "usage update failed", error: error.message });
    return null;
  }
  return typeof data === "number" ? data : null;
}

export type DailyUsage = { day: string; legs: number; minutes: number; smsCount: number };

export async function loadDailyUsage(admin: AdminClient, input: { organizationId: string; now?: Date }): Promise<DailyUsage> {
  const day = usageDay(input.now ?? new Date());
  const { data } = await admin.from("motorist_telephony_daily_usage").select("*").eq("organization_id", input.organizationId).eq("day", day).maybeSingle();
  return { day, legs: Number(data?.legs ?? 0), minutes: Number(data?.minutes ?? 0), smsCount: Number(data?.sms_count ?? 0) };
}

/** True when today's legs already reached the org's soft cap. */
export function isOverLegCap(usage: DailyUsage, cap: number | null | undefined): boolean {
  const limit = typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_DAILY_LEG_SOFT_CAP;
  return usage.legs >= limit;
}
