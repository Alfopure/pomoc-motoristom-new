import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase } from "@/test/fake-supabase";

let fake: ReturnType<typeof createFakeSupabase>;
const dispatchData = { marker: "refreshed" };

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => fake.admin,
}));
vi.mock("@/lib/supabase/env", () => ({
  getSupabaseServiceEnv: () => ({ url: "https://copy.test", publicKey: "public", serviceKey: "service" }),
}));
vi.mock("@/data/dispatch-repository", () => ({
  loadDispatchData: vi.fn(async () => dispatchData),
}));

import { linkCallToCase } from "./telephony-workflow";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const PROFILE_ID = "00000000-0000-4000-8000-000000000101";
const CASE_ID = "00000000-0000-4000-8000-000000000801";
const SESSION_ID = "00000000-0000-4000-8000-000000000701";
const CALL_ID = "00000000-0000-4000-8000-000000000901";

beforeEach(() => {
  fake = createFakeSupabase({ now: () => new Date("2026-09-07T12:00:00.000Z") });
  fake.db.seed("motorist_organizations", [{ id: ORG_ID, slug: "pomoc-motoristom", active: true }]);
  fake.db.seed("motorist_profiles", [{ id: PROFILE_ID, organization_id: ORG_ID, active: true, created_at: "2026-01-01T00:00:00.000Z" }]);
  fake.db.seed("motorist_cases", [{ id: CASE_ID, organization_id: ORG_ID, case_number: "PM-2026-0001", status: "open" }]);
  fake.db.seed("motorist_call_sessions", [{
    id: SESSION_ID,
    organization_id: ORG_ID,
    direction: "inbound",
    caller_number: "+421905123456",
    called_number: "+421232408718",
    started_at: "2026-09-07T11:59:00.000Z",
    case_id: null,
  }]);
  fake.db.seed("motorist_calls", [{
    id: CALL_ID,
    organization_id: ORG_ID,
    provider: "telnyx",
    provider_session_id: "provider-session",
    session_id: SESSION_ID,
    direction: "inbound",
    status: "answered",
    caller_number: "+421905123456",
    case_id: null,
    raw_latest_payload: {},
  }]);
});

describe("linkCallToCase", () => {
  it("updates both the call log and its live session after a manual link", async () => {
    await expect(linkCallToCase(CALL_ID, CASE_ID)).resolves.toBe(dispatchData);

    expect(fake.db.find("motorist_calls", (row) => row.id === CALL_ID)).toMatchObject({ case_id: CASE_ID });
    expect(fake.db.find("motorist_call_sessions", (row) => row.id === SESSION_ID)).toMatchObject({ case_id: CASE_ID });
    expect(fake.db.rows("motorist_call_events")).toEqual([
      expect.objectContaining({ call_id: CALL_ID, event_type: "app.link_case" }),
    ]);
    expect(fake.db.rows("motorist_case_events")).toEqual([
      expect.objectContaining({ case_id: CASE_ID, event_type: "call_linked" }),
    ]);
  });
});
