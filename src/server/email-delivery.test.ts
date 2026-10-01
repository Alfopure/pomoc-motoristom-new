import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAppUrl, getEmailConfig, requestOrigin, sendEmail } from "./email-delivery";

const emailEnvKeys = ["EMAIL_PROVIDER", "EMAIL_FROM", "EMAIL_REPLY_TO", "EMAIL_APP_NAME", "RESEND_API_KEY", "APP_BASE_URL",
  "MOTORIST_APP_ENV", "MOTORIST_TEST_LIVE_INTEGRATIONS", "MOTORIST_TEST_ALLOWED_EMAILS", "VERCEL_ENV", "VERCEL_GIT_COMMIT_REF", "VERCEL_PROJECT_ID",
  "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_PROJECT_REF", "EXPECTED_SUPABASE_PROJECT_REF"] as const;
const TEST_ENV = {
  MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
  VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk",
  APP_BASE_URL: "https://test.dispecing.linkapomoci.sk", NEXT_PUBLIC_SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co",
  MOTORIST_TEST_LIVE_INTEGRATIONS: "true", MOTORIST_TEST_ALLOWED_EMAILS: "tester@example.com, delivered+smoke@resend.dev",
  EMAIL_PROVIDER: "resend", EMAIL_FROM: "test@example.com", RESEND_API_KEY: "synthetic-test-key",
};
const TEST_MESSAGE = { to: "tester@example.com", subject: "TEST", html: "<p>TEST</p>", text: "TEST" };

describe("email-delivery", () => {
  beforeEach(() => {
    for (const key of emailEnvKeys) {
      delete process.env[key];
    }

    vi.unstubAllGlobals();
  });

  afterEach(() => {
    for (const key of emailEnvKeys) {
      delete process.env[key];
    }

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends Resend email with authorization, user agent and idempotency key", async () => {
    process.env.EMAIL_PROVIDER = "resend";
    process.env.EMAIL_FROM = "noreply@example.com";
    process.env.EMAIL_REPLY_TO = "support@example.com";
    process.env.EMAIL_APP_NAME = "Pomoc Motoristom";
    process.env.RESEND_API_KEY = "re_test_key";

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "email_123" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendEmail({
      to: "matej@example.com",
      subject: "Prístup\nPomoc Motoristom",
      html: "<p>Aktivovať</p>",
      text: "Aktivovať",
      idempotencyKey: "access-invite-profile-1",
    });

    expect(result).toEqual({ status: "sent", provider: "resend", messageId: "email_123", error: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer re_test_key",
      "User-Agent": "Pomoc-Motoristom-mailer/1.0",
      "Idempotency-Key": "access-invite-profile-1",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      from: "Pomoc Motoristom <noreply@example.com>",
      to: ["matej@example.com"],
      replyTo: "support@example.com",
      subject: "Prístup Pomoc Motoristom",
      html: "<p>Aktivovať</p>",
      text: "Aktivovať",
    });
  });

  it("does not send when Resend configuration is missing", async () => {
    process.env.EMAIL_PROVIDER = "resend";
    process.env.EMAIL_FROM = "noreply@example.com";

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const config = getEmailConfig();
    const result = await sendEmail({
      to: "matej@example.com",
      subject: "Prístup",
      html: "<p>Aktivovať</p>",
      text: "Aktivovať",
      idempotencyKey: "access-invite-profile-1",
    });

    expect(config.enabled).toBe(false);
    expect(result.status).toBe("disabled");
    expect(result.error).toContain("RESEND_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends only approved TEST addresses, without requiring telephony configuration", async () => {
    Object.assign(process.env, TEST_ENV);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "test_email" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await sendEmail({ ...TEST_MESSAGE, to: ["TESTER@example.com", "delivered+smoke@resend.dev"] })).status).toBe("sent");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["one unapproved recipient", "tester@example.com,customer@example.com"],
    ["a display name instead of an exact address", "Tester <tester@example.com>"],
    ["a different plus label", "tester+other@example.com"],
  ])("refuses TEST email with %s without a provider request", async (_label, to) => {
    Object.assign(process.env, TEST_ENV);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await sendEmail({ ...TEST_MESSAGE, to })).status).toBe("disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { VERCEL_ENV: "preview" },
    { VERCEL_GIT_COMMIT_REF: "feature/test" },
    { MOTORIST_TEST_LIVE_INTEGRATIONS: "false" },
    { MOTORIST_APP_ENV: "" },
    { MOTORIST_APP_ENV: "unknown" },
    { SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co" },
    { APP_BASE_URL: "https://dispecing.linkapomoci.sk" },
    { MOTORIST_TEST_ALLOWED_EMAILS: "" },
    { MOTORIST_TEST_ALLOWED_EMAILS: "*@example.com" },
    { MOTORIST_TEST_ALLOWED_EMAILS: "tester@example.com,invalid" },
    { MOTORIST_TEST_ALLOWED_EMAILS: Array.from({ length: 51 }, (_, i) => `tester${i}@example.com`).join(",") },
  ])("fails closed for an invalid TEST email boundary: %j", async override => {
    Object.assign(process.env, TEST_ENV, override);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(getEmailConfig().enabled).toBe(false);
    expect((await sendEmail(TEST_MESSAGE)).status).toBe("disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let an unmarked local TEST database send email", async () => {
    Object.assign(process.env, TEST_ENV, { MOTORIST_APP_ENV: "", VERCEL_ENV: "", VERCEL_GIT_COMMIT_REF: "" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await sendEmail(TEST_MESSAGE)).status).toBe("disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps ordinary production email independent of TEST allowlists", async () => {
    Object.assign(process.env, { EMAIL_PROVIDER: "resend", EMAIL_FROM: "prod@example.com", RESEND_API_KEY: "synthetic",
      VERCEL_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "production_email" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await sendEmail({ ...TEST_MESSAGE, to: "ordinary@example.com" })).status).toBe("sent");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("prefers APP_BASE_URL over the request origin when building app links", () => {
    process.env.APP_BASE_URL = "https://dispecing.example.com";

    expect(buildAppUrl("/auth/callback?next=%2Fauth%2Fset-password", "https://other.example.com")).toBe(
      "https://dispecing.example.com/auth/callback?next=%2Fauth%2Fset-password",
    );
  });

  it("falls back to the request origin and then localhost when APP_BASE_URL is missing", () => {
    expect(buildAppUrl("/auth/callback", "https://pomoc-motoristom-dispecing.vercel.app")).toBe("https://pomoc-motoristom-dispecing.vercel.app/auth/callback");
    expect(buildAppUrl("/auth/callback")).toBe("http://localhost:3000/auth/callback");
  });

  it("reads the origin from a request and tolerates missing requests", () => {
    expect(requestOrigin(new Request("https://pomoc-motoristom-dispecing.vercel.app/api/users/1/access/send"))).toBe("https://pomoc-motoristom-dispecing.vercel.app");
    expect(requestOrigin(undefined)).toBeUndefined();
  });
});
