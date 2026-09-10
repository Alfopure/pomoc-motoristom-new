import { describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
const admin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: admin }));
import { loadSmsHistory, loadSmsOptions } from "./sms-repository";
describe("shared SMS history", () => {
  it("offers explicit original-case open task options scoped to the organization", async () => {
    const fake = createFakeSupabase(); admin.mockReturnValue(fake.admin);
    fake.db.seed("motorist_case_tasks", [
      { id: "open", organization_id: "org", case_id: "case", status: "open", title: "Choose me" },
      { id: "done", organization_id: "org", case_id: "case", status: "done", title: "Done" },
      { id: "foreign", organization_id: "other", case_id: "case", status: "open" },
      { id: "independent", organization_id: "org", case_id: null, status: "open" },
    ]);
    expect((await loadSmsOptions("org")).tasks).toEqual([{ id: "open", caseId: "case", title: "Choose me" }]);
  });

  it("includes messages without cases and isolates organization and case filters", async () => {
    const fake = createFakeSupabase(); admin.mockReturnValue(fake.admin);
    fake.db.seed("motorist_sms_messages", [
      { id: "global", organization_id: "org", provider: "telnyx_sms", case_id: null, body: "Global", raw_payload: {}, created_at: "2026-09-07T10:00:00Z" },
      { id: "case", organization_id: "org", provider: "telnyx_sms", case_id: "case-1", body: "Case", raw_payload: { actor_profile_id: "author" }, created_at: "2026-09-07T11:00:00Z" },
      { id: "foreign", organization_id: "other", provider: "telnyx_sms", case_id: null, body: "Foreign", raw_payload: {} },
    ]);
    fake.db.seed("motorist_profiles", [{ id: "author", organization_id: "org", display_name: "Dispečer" }]);
    expect((await loadSmsHistory("org", null)).messages.map((r) => r.id)).toEqual(["case", "global"]);
    expect((await loadSmsHistory("org", "case-1")).messages).toMatchObject([{ id: "case", author: "Dispečer" }]);
  });
});
