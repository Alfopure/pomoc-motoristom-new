import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
const admin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: admin }));
import { POST } from "@/app/api/sms/telnyx/webhook/route";
const pair = generateKeyPairSync("ed25519");
const profile = "4001a062-7f1b-45cc-9daf-5e110f66db17";
function payload(messagingProfile = profile) {
  return { data: { id: "event", event_type: "message.received", occurred_at: new Date().toISOString(), payload: {
    id: "message", messaging_profile_id: messagingProfile, direction: "inbound", from: { phone_number: "+421905123456" },
    to: [{ phone_number: "+12025550123", status: "webhook_delivered" }], text: "Moja odpoveď.",
  } } };
}
function signedRequest(value: unknown, mutate = false) {
  const raw = JSON.stringify(value); const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://sms.test/api/sms/telnyx/webhook", { method: "POST", body: mutate ? raw + " " : raw,
    headers: { "telnyx-timestamp": timestamp, "telnyx-signature-ed25519": sign(null, Buffer.from(`${timestamp}|${raw}`), pair.privateKey).toString("base64") } });
}
beforeEach(() => {
  admin.mockReset();
  vi.stubEnv("TELNYX_API_KEY", "test"); vi.stubEnv("TELNYX_PUBLIC_KEY", pair.publicKey.export({ format: "pem", type: "spki" }).toString());
  vi.stubEnv("TELNYX_MESSAGING_PROFILE_ID", profile); vi.stubEnv("TELNYX_SMS_FROM_NUMBER", "+12025550123");
  vi.stubEnv("TELNYX_SMS_ORGANIZATION_ID", "11111111-1111-4111-8111-111111111111");
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("SMS webhook acknowledgement", () => {
  it("verifies original signed bytes before database access", async () => {
    expect((await POST(signedRequest(payload(), true))).status).toBe(400);
    expect(admin).not.toHaveBeenCalled();
  });
  it("acknowledges only after a durable insert and retries an unavailable database", async () => {
    const h = createFakeSupabase(); admin.mockReturnValue(h.admin);
    h.db.failNext("motorist_sms_messages", "insert", "db unavailable");
    expect((await POST(signedRequest(payload()))).status).toBe(503);
    expect(h.db.rows("motorist_sms_messages")).toHaveLength(0);
    const response = await POST(signedRequest(payload()));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ outcome: "stored" });
    expect(h.db.rows("motorist_sms_messages")).toHaveLength(1);
  });
  it("keeps an unconfigured receiving channel inactive and rejects malformed envelopes", async () => {
    vi.stubEnv("TELNYX_SMS_FROM_NUMBER", "");
    expect((await POST(signedRequest(payload()))).status).toBe(503);
    expect((await POST(signedRequest({}))).status).toBe(400);
    expect(admin).not.toHaveBeenCalled();
  });
  it("does not access this environment's database for a foreign messaging profile", async () => {
    const response = await POST(signedRequest(payload("foreign")));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ outcome: "foreign_profile" });
    expect(admin).not.toHaveBeenCalled();
  });
});
