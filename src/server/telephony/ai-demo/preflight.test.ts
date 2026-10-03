import { describe, expect, it } from "vitest";

import { createFakeOpenAIFetch } from "@/test/fake-openai-live";
import { createTelephonyHarness, LINES, NUMBERS } from "@/test/telephony-harness";
import { runAiDemoPreflight } from "./preflight";

describe("AI demo caller ID readiness", () => {
  it.each([
    { active: true, metadata: {}, ready: true },
    { active: false, metadata: {}, ready: false },
    { active: true, metadata: { archived_at: "2026-10-03T12:00:00.000Z" }, ready: false },
    { active: false, metadata: { archived_at: "2026-10-03T12:00:00.000Z" }, ready: false },
  ])("reports readiness=$ready for active=$active metadata=$metadata without provider calls", async ({ active, metadata, ready }) => {
    const h = createTelephonyHarness();
    h.db.update("motorist_telephony_lines", { active, metadata }, row => row.id === LINES.allianz);
    const openai = createFakeOpenAIFetch();
    const env = {
      AI_DEMO_ENABLED: "true", AI_DEMO_FROM_NUMBER: NUMBERS.allianz,
      OPENAI_API_KEY: "sk-proj-test", OPENAI_LIVE_PROJECT_ID: "proj_test123", OPENAI_WEBHOOK_SECRET: "whsec_c2VjcmV0",
    };

    const result = await runAiDemoPreflight({ ...h.deps, env, openAIFetch: openai.fetch }, { remote: false });

    expect(result.configured).toBe(true);
    expect(result.fromLineActive).toBe(ready);
    expect(h.telnyx.calls).toHaveLength(0);
    expect(openai.calls).toHaveLength(0);
    expect(h.rows("motorist_ai_demo_attempts")).toHaveLength(0);
  });
});
