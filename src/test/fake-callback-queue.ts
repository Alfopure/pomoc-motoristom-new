import { createHash } from "node:crypto";
import { callbackOrigin } from "@/lib/telephony/callback-origin";
import type { FakeDatabase } from "./fake-supabase";

/** Adapter only; the exact migration is verified against local PostgreSQL. */
export function registerCallbackQueueRpc(db: FakeDatabase) {
  db.registerRpc("motorist_callback_queue_page_v1", args => {
    const cursor = args.p_cursor as { revision: string; rank: number; sortAt: string; id: string } | null;
    const totals = { requested: 0, missed: 0, manual: 0, unknown: 0 };
    const entries = db.rows("motorist_callback_requests")
      .filter(row => row.organization_id === args.p_organization_id && ["open", "scheduled"].includes(String(row.status)))
      .map(row => {
        const session = db.find("motorist_call_sessions", item => item.id === row.session_id && item.organization_id === row.organization_id);
        const origin = callbackOrigin(String(row.source), row.metadata, session?.metadata);
        totals[origin.kind]++;
        const at = origin.kind === "requested" ? (origin.requestedAt && Number.isFinite(Date.parse(origin.requestedAt)) ? origin.requestedAt : "9999-12-31T23:59:59.999Z") : String(row.created_at);
        return { request: row, sessionMetadata: session?.metadata, rank: origin.kind === "requested" ? 0 : 1, sortAt: new Date(at).toISOString() };
      });
    const compare = (a: typeof entries[number], b: typeof entries[number]) => a.rank - b.rank || a.sortAt.localeCompare(b.sortAt) || String(a.request.id).localeCompare(String(b.request.id));
    entries.sort(compare);
    const revision = createHash("md5").update(JSON.stringify(entries.map(entry => [entry.request.id, entry.rank, entry.sortAt]))).digest("hex");
    const reset = Boolean(cursor && cursor.revision !== revision);
    const eligible = cursor && !reset ? entries.filter(entry => compare(entry, { request: { id: cursor.id }, sessionMetadata: undefined, rank: cursor.rank, sortAt: cursor.sortAt }) > 0) : entries;
    return { entries: eligible.slice(0, Number(args.p_limit ?? 100) + 1), revision, reset, openTotal: entries.length, totalsByOrigin: totals };
  });
}
