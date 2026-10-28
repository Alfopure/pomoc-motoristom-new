import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MobilePushData, MobilePushType } from "@/lib/mobile-api";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { mobileEnvironment } from "./auth";
import { deliverPushNotices, mobilePushEnabled, queueMobilePush, STALE_DEVICE_DAYS, storedPreferences, type PushDevice, type PushNotice, type PushTransport } from "./push";

/** Work notices (branch queue, own assignments, damage reports) come from the
 * database outbox written in the same transaction as the change. A claim lease
 * keeps the immediate send and the cron drain from sending a row twice; the
 * server re-checks each recipient's access before it hands out a row. */
export type OutboxRow = { id: string; memberId: string | null; profileId: string | null; type: Extract<MobilePushType, "work" | "branch">; event: string; title: string; body: string; target: MobilePushData };
export type OutboxOutcome = { id: string; outcome: "sent" | "no_device" | "failed" };
export type OutboxDrain = { claimed: number; sent: number; noDevice: number; failed: number };
type Admin = SupabaseClient;
const READ_MS = 8_000;

/** Per row: any phone reached is sent; no wanting phone (or all removed) is no_device. */
export function outboxOutcomes(rows: readonly OutboxRow[], notices: readonly { rowId: string }[], outcomes: readonly ("sent" | "gone" | "failed")[]): OutboxOutcome[] {
  return rows.map(row => {
    const mine = notices.map((notice, index) => notice.rowId === row.id ? outcomes[index] : null).filter((value): value is "sent" | "gone" | "failed" => value !== null);
    if (mine.includes("sent")) return { id: row.id, outcome: "sent" };
    if (!mine.length || mine.every(value => value === "gone")) return { id: row.id, outcome: "no_device" };
    return { id: row.id, outcome: "failed" };
  });
}

async function devicesFor(admin: Admin, organizationId: string, rows: readonly OutboxRow[], now: Date): Promise<Map<string, PushDevice[]>> {
  const owners = new Map<string, PushDevice[]>();
  const members = [...new Set(rows.flatMap(row => row.memberId ? [row.memberId] : []))];
  const profiles = [...new Set(rows.flatMap(row => row.profileId ? [row.profileId] : []))];
  const since = new Date(now.getTime() - STALE_DEVICE_DAYS * 86_400_000).toISOString();
  for (const [column, ids] of [["member_id", members], ["profile_id", profiles]] as const) {
    if (!ids.length) continue;
    const result = await admin.from("motorist_mobile_push_devices").select("id,member_id,profile_id,expo_push_token,preferences").eq("organization_id", organizationId)
      .eq("environment", mobileEnvironment()).in(column, ids).gte("last_seen_at", since).limit(500).abortSignal(AbortSignal.timeout(READ_MS));
    if (result.error) throw new Error("push devices unavailable");
    for (const row of (result.data ?? []) as { id: string; member_id: string | null; profile_id: string | null; expo_push_token: string; preferences: unknown }[]) {
      const owner = column === "member_id" ? row.member_id : row.profile_id;
      if (!owner) continue;
      // The owner id travels as `profileId`, so the app opens the notice only in that account.
      owners.set(owner, [...owners.get(owner) ?? [], { id: row.id, profileId: owner, token: row.expo_push_token, preferences: storedPreferences(row.preferences) }]);
    }
  }
  return owners;
}

/** Claims due notices of one organization, sends them and records the outcome. Never throws. */
export async function drainPushOutbox(admin: Admin, organizationId: string, options: { limit?: number; now?: Date; transport?: PushTransport } = {}): Promise<OutboxDrain> {
  const drain: OutboxDrain = { claimed: 0, sent: 0, noDevice: 0, failed: 0 };
  if (!mobilePushEnabled()) return drain;
  let rows: OutboxRow[] = [];
  try {
    const claim = await admin.rpc("motorist_push_outbox_claim", { p_organization_id: organizationId, p_limit: options.limit ?? 50 }).abortSignal(AbortSignal.timeout(READ_MS));
    if (claim.error) { if (!["PGRST202", "42883"].includes(claim.error.code ?? "")) console.warn(JSON.stringify({ event: "mobile.push.outbox", error: claim.error.code })); return drain; }
    rows = (claim.data ?? []) as OutboxRow[];
    drain.claimed = rows.length;
    if (!rows.length) return drain;
    const owners = await devicesFor(admin, organizationId, rows, options.now ?? new Date());
    const notices: (PushNotice & { rowId: string })[] = rows.flatMap(row => (owners.get((row.memberId ?? row.profileId)!) ?? [])
      .filter(device => device.preferences[row.type]).map(device => ({ rowId: row.id, device, title: row.title, body: row.body, data: row.target })));
    const delivered = notices.length ? await deliverPushNotices(admin as never, notices, options.transport) : [];
    const results = outboxOutcomes(rows, notices, delivered);
    for (const result of results) drain[result.outcome === "sent" ? "sent" : result.outcome === "no_device" ? "noDevice" : "failed"] += 1;
    await admin.rpc("motorist_push_outbox_finish", { p_organization_id: organizationId, p_results: results }).abortSignal(AbortSignal.timeout(READ_MS));
  } catch (error) {
    // Unfinished rows keep their lease and return to the queue when it expires.
    console.warn(JSON.stringify({ event: "mobile.push.outbox", error: error instanceof Error ? error.message : "failed", claimed: drain.claimed }));
  }
  return drain;
}

/** After a work command: send what it queued without waiting for the cron. */
export function queueWorkPush(organizationId: string) {
  queueMobilePush(() => drainPushOutbox(createSupabaseAdminClient() as unknown as Admin, organizationId, { limit: 20 }));
}
