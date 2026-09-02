import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAppUrl, getEmailConfig, requestOrigin, sendEmail } from "./email-delivery";

const emailEnvKeys = ["EMAIL_PROVIDER", "EMAIL_FROM", "EMAIL_REPLY_TO", "EMAIL_APP_NAME", "RESEND_API_KEY", "APP_BASE_URL"] as const;

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
