import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { normalizeDialNumberForComparison } from "@/lib/telephony/phone";

type Entry = { name: string; phone: string | null };
const cache = new Map<string, { until: number; names: Promise<Map<string, string>> }>();
export function clearCallContactNameCache() { cache.clear(); }

/** Exact normalized identities only. Names describe contacts, never authorize a call. */
export function contactNamesFromEntries(entries: readonly Entry[], numbers: readonly string[]) {
  const wanted = new Set(numbers.map(normalizeDialNumberForComparison).filter(Boolean));
  const names = new Map<string, string>();
  for (const entry of entries) {
    const phone = normalizeDialNumberForComparison(entry.phone);
    if (wanted.has(phone) && entry.name.trim() && !names.has(phone)) names.set(phone, entry.name.trim());
  }
  return names;
}

export function loadCallContactNames(admin: SupabaseClient<Database>, organizationId: string, rawNumbers: readonly (string | null)[], timeoutMs = 2500): Promise<Map<string, string>> {
  const numbers = [...new Set(rawNumbers.map(normalizeDialNumberForComparison).filter(number => number.length >= 6))].sort().slice(0,200);
  if (!numbers.length) return Promise.resolve(new Map());
  const key = `${organizationId}:${timeoutMs}:${numbers.join(",")}`;
  const now = Date.now(), hit = cache.get(key);
  if (hit && hit.until > now) return hit.names;
  const names = (async () => {
    const { data, error } = await admin.rpc("motorist_resolve_call_contacts", { p_organization_id: organizationId, p_numbers: numbers }).abortSignal(AbortSignal.timeout(timeoutMs));
    if (error || !data) return new Map<string,string>();
    const wanted = new Set(numbers);
    return new Map(data.filter(row => wanted.has(row.number) && row.name.trim()).map(row => [row.number, row.name.trim()]));
  })().catch(() => new Map<string, string>());
  if (cache.size > 200) cache.clear();
  cache.set(key, { until: now + 5000, names });
  return names;
}
