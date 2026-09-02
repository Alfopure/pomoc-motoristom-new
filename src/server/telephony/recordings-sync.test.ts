import { describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

import { claimRecording, defaultDateFrom, discoverNewRecordings, resolveMimeType, storagePathFor } from "./recordings-sync";
import { normalizeCdrRecord } from "@/lib/integrations/viptel/client";

type QueryResult = { data?: unknown; error?: { message: string; code?: string } | null; count?: number };

// Minimal chainable stub: every builder method returns itself; awaiting it resolves the
// next queued result for that table. Enough to drive discovery/claim control flow.
function stubSupabase(queues: Record<string, QueryResult[]>) {
  const calls: Array<{ table: string; inserted?: unknown; updated?: unknown }> = [];

  const client = {
    from(table: string) {
      const entry: { table: string; inserted?: unknown; updated?: unknown } = { table };
      calls.push(entry);
      const result = (queues[table] ?? []).shift() ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      const chain = () => builder;

      for (const method of ["select", "eq", "in", "order", "limit", "maybeSingle", "single"]) {
        builder[method] = chain;
      }

      builder.insert = (payload: unknown) => {
        entry.inserted = payload;
        return builder;
      };
      builder.update = (payload: unknown) => {
        entry.updated = payload;
        return builder;
      };
      builder.then = (resolve: (value: QueryResult) => unknown) => Promise.resolve(result).then(resolve);

      return builder;
    },
  };

  return { client: client as unknown as SupabaseClient<Database>, calls };
}

const cdrFixture = normalizeCdrRecord({
  id: "3",
  type: "incoming",
  when: "2026-05-28 11:06:53",
  caller: "00421910818189",
  destination: "10",
  duration: "36",
  status: "answered",
  recording_file: "q-500.mp3",
  unique_id: "1779959213.4",
});

describe("discoverNewRecordings", () => {
  it("skips CDR ids that already exist (idempotent re-run)", async () => {
    const { client, calls } = stubSupabase({
      motorist_call_recordings: [{ data: [{ provider_recording_id: "3" }], error: null }],
    });

    const inserted = await discoverNewRecordings(client, "org-1", [cdrFixture]);
    expect(inserted).toBe(0);
    expect(calls.filter((call) => call.inserted !== undefined)).toHaveLength(0);
  });

  it("inserts a pending recording and links the existing call", async () => {
    const { client, calls } = stubSupabase({
      motorist_call_recordings: [
        { data: [], error: null }, // existing-id lookup
        { data: null, error: null }, // insert
      ],
      motorist_calls: [{ data: { id: "call-9" }, error: null }],
    });

    const inserted = await discoverNewRecordings(client, "org-1", [cdrFixture]);
    expect(inserted).toBe(1);

    const insert = calls.find((call) => call.table === "motorist_call_recordings" && call.inserted) as
      | { inserted: Record<string, unknown> }
      | undefined;
    expect(insert?.inserted).toMatchObject({
      provider_recording_id: "3",
      call_id: "call-9",
      status: "pending",
    });
  });

  it("treats a unique violation on insert as already-discovered", async () => {
    const { client } = stubSupabase({
      motorist_call_recordings: [
        { data: [], error: null },
        { data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } },
      ],
      motorist_calls: [{ data: { id: "call-9" }, error: null }],
    });

    const inserted = await discoverNewRecordings(client, "org-1", [cdrFixture]);
    expect(inserted).toBe(0);
  });
});

describe("claimRecording", () => {
  const baseRow = {
    id: "rec-1",
    status: "pending",
    metadata: {},
  } as unknown as Parameters<typeof claimRecording>[1];

  it("claims a pending row when the conditional update matches", async () => {
    const { client } = stubSupabase({ motorist_call_recordings: [{ data: [{ id: "rec-1" }], error: null }] });
    await expect(claimRecording(client, baseRow)).resolves.toBe(true);
  });

  it("does not claim when another run already took the row", async () => {
    const { client } = stubSupabase({ motorist_call_recordings: [{ data: [], error: null }] });
    await expect(claimRecording(client, baseRow)).resolves.toBe(false);
  });

  it("honours a fresh claim lease without touching the database", async () => {
    const { client, calls } = stubSupabase({});
    const row = { ...baseRow, metadata: { claimed_at: new Date().toISOString() } } as typeof baseRow;
    await expect(claimRecording(client, row)).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("storagePathFor", () => {
  it("builds org/call/cdr path with the recording file extension", () => {
    const path = storagePathFor("org-1", {
      call_id: "call-1",
      provider_recording_id: "42",
      recording_file: "q-500-00421910818189-20260528-110653-1779959213.4.mp3",
    });
    expect(path).toBe("org-1/call-1/42.mp3");
  });

  it("falls back to call-unlinked and .mp3", () => {
    const path = storagePathFor("org-1", { call_id: null, provider_recording_id: "7", recording_file: null });
    expect(path).toBe("org-1/call-unlinked/7.mp3");
  });

  it("keeps a wav extension", () => {
    const path = storagePathFor("org-1", { call_id: "c", provider_recording_id: "9", recording_file: "x.WAV" });
    expect(path).toBe("org-1/c/9.wav");
  });
});

describe("resolveMimeType", () => {
  it("prefers a concrete provider content type", () => {
    expect(resolveMimeType("audio/wav", "x.mp3")).toBe("audio/wav");
  });

  it("derives from the filename when the provider says octet-stream", () => {
    expect(resolveMimeType("application/octet-stream", "rec.wav")).toBe("audio/wav");
    expect(resolveMimeType("application/octet-stream", "rec.ogg")).toBe("audio/ogg");
    expect(resolveMimeType("application/octet-stream", "rec.mp3")).toBe("audio/mpeg");
  });

  it("defaults to audio/mpeg", () => {
    expect(resolveMimeType(null, null)).toBe("audio/mpeg");
  });
});

describe("defaultDateFrom", () => {
  it("returns a 48h lookback formatted for the VIPTel CDR API", () => {
    const value = defaultDateFrom(new Date("2026-07-02T10:00:00Z"));
    expect(value).toBe("2026-06-30 00:00:00");
  });
});
