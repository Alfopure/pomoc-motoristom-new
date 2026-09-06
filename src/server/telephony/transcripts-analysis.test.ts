import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  writes: [] as Array<{ table: string; value: Record<string, unknown> }>,
  analyze: vi.fn(),
  configured: vi.fn(() => true),
}));

vi.mock("@/lib/integrations/ai/call-analysis", () => ({
  analyzeCallTranscript: fixture.analyze,
  isCallAnalysisConfigured: fixture.configured,
  getCallAnalysisModel: () => "gpt-5.6-luna",
  DEFAULT_QA_RUBRIC: "synthetic rubric",
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: (table: string) => {
      let operation = "select";
      let columns = "";
      const result = () => {
        if (operation !== "select") return { data: null, error: null };
        if (table === "motorist_organizations") return { data: { id: "test-org", active: true }, error: null };
        if (table === "motorist_call_recordings") return { data: columns === "metadata" ? { metadata: { speaker_confidence: 0.99 } } : [], error: null };
        if (table === "motorist_call_transcripts") return {
          data: [{ id: "test-transcript", organization_id: "test-org", call_id: "test-call", recording_id: "test-recording", transcript_text: "Syntetický súkromný prepis.", speaker_segments: [], extracted_fields: {} }], error: null,
        };
        if (table === "motorist_calls") return { data: { direction: "inbound", duration_seconds: 30 }, error: null };
        return { data: { config: {} }, error: null };
      };
      const query = {
        select: (value: string) => { columns = value; return query; },
        update: (value: Record<string, unknown>) => { operation = "update"; fixture.writes.push({ table, value }); return query; },
        insert: (value: Record<string, unknown>) => { operation = "insert"; fixture.writes.push({ table, value }); return query; },
        eq: () => query, not: () => query, is: () => query, order: () => query, limit: () => query,
        maybeSingle: async () => result(),
        then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve),
      };
      return query;
    },
  }),
}));

import { processTranscripts } from "./transcripts-process";

afterEach(() => { vi.unstubAllEnvs(); fixture.writes.length = 0; fixture.analyze.mockReset(); fixture.configured.mockReturnValue(true); });

describe("GPT transcript persistence", () => {
  it("gates unverified employee scores and keeps derived private content out of broadly readable calls", async () => {
    vi.stubEnv("TRANSCRIPTS_ENABLED", "true");
    fixture.analyze.mockResolvedValue({ summary: "Syntetický súkromný súhrn.", extracted_fields: { spz: null, lokalita: null, typ_poruchy: null, dohodnuty_krok: null, telefon: null }, qa_score: null, qa_breakdown: null, qa_notes: [] });

    const result = await processTranscripts();

    expect(result.aiProcessed).toBe(1);
    expect(result.aiFailed).toBe(0);
    expect(fixture.analyze).toHaveBeenCalledWith(expect.objectContaining({ includeQa: false }));
    expect(fixture.writes.filter((write) => write.table === "motorist_calls")).toEqual([]);
    expect(fixture.writes.find((write) => write.table === "motorist_call_transcripts")?.value).toMatchObject({
      model: "scribe_v2+gpt-5.6-luna", qa_score: null, extracted_fields: { qa_gated: true },
    });
  });

  it("does not send transcripts or write AI content while the explicit AI gate is disabled", async () => {
    vi.stubEnv("TRANSCRIPTS_ENABLED", "true");
    fixture.configured.mockReturnValue(false);
    const result = await processTranscripts();
    expect(result.aiSkipped).toBe(1);
    expect(fixture.analyze).not.toHaveBeenCalled();
    expect(fixture.writes.some((write) => write.table === "motorist_call_transcripts")).toBe(false);
  });
});
