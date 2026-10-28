import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { createFakeSupabase } from "@/test/fake-supabase";
import { recordCallEvent } from "./effects";
import type { SessionEvent } from "./types";

const ORG = "00000000-0000-4000-8000-000000000001";
const event: SessionEvent = { kind: "app", type: "hangup", id: "evt-redelivered", actorProfileId: null, occurredAt: "2026-10-28T10:00:00.000Z" };
const audit = { session: null, event, handledStatus: "processed" as const, stateBefore: "talking", stateAfter: "ended", notes: [], commands: [] };

describe("call event audit idempotency", () => {
  it("writes ON CONFLICT DO NOTHING on the table's unique key instead of a plain INSERT", async () => {
    const upsert = vi.fn(async () => ({ data: null, error: null }));
    const insert = vi.fn(async () => ({ data: null, error: null }));
    const admin = { from: vi.fn(() => ({ upsert, insert })) } as unknown as SupabaseClient<Database>;

    await recordCallEvent({ admin, organizationId: ORG, now: () => new Date("2026-10-28T10:00:01.000Z") }, audit);

    expect(insert).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ organization_id: ORG, provider: "telnyx", event_fingerprint: event.id }),
      { onConflict: "organization_id,provider,event_fingerprint", ignoreDuplicates: true });
  });

  it("keeps the first row and reports no error for a duplicate delivery", async () => {
    const fake = createFakeSupabase({ now: () => new Date("2026-10-28T10:00:01.000Z") });
    const deps = { admin: fake.admin, organizationId: ORG, now: () => new Date("2026-10-28T10:00:01.000Z") };

    await recordCallEvent(deps, { ...audit, notes: ["first"] });
    await expect(recordCallEvent(deps, { ...audit, notes: ["redelivered"] })).resolves.toBeUndefined();

    const rows = fake.db.rows("motorist_call_events").filter((row) => row.event_fingerprint === event.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].normalized_payload).toMatchObject({ notes: ["first"] });
  });

  it("still fails loudly for a real write error", async () => {
    const fake = createFakeSupabase();
    fake.db.failNext("motorist_call_events", "upsert", "disk full");
    await expect(recordCallEvent({ admin: fake.admin, organizationId: ORG, now: () => new Date() }, audit)).rejects.toThrow(/call event insert failed: disk full/);
  });
});
