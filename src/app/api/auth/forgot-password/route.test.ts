import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationError } from "@/server/motorist-mutations";
import { FORGOT_PASSWORD_GENERIC_MESSAGE, sendForgotPassword } from "@/server/access-management";
import { POST } from "./route";

vi.mock("@/server/access-management", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/access-management")>();

  return {
    ...actual,
    sendForgotPassword: vi.fn(),
  };
});

const mockedSendForgotPassword = vi.mocked(sendForgotPassword);

describe("forgot password route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockedSendForgotPassword.mockReset();
  });

  it("returns the generic success response when reset processing succeeds", async () => {
    mockedSendForgotPassword.mockResolvedValue({ ok: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE });

    const response = await POST(
      new Request("https://example.com/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: "admin@example.com" }),
      }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE });
    expect(response.status).toBe(200);
    expect(mockedSendForgotPassword).toHaveBeenCalledTimes(1);
  });

  it("does not leak known account state through HTTP status", async () => {
    mockedSendForgotPassword.mockRejectedValue(new MutationError("Používateľ ešte nemá vytvorený auth účet.", 400));

    const response = await POST(
      new Request("https://example.com/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: "admin@example.com" }),
      }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE });
    expect(response.status).toBe(200);
  });

  it("keeps unexpected failures generic for callers", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedSendForgotPassword.mockRejectedValue(new Error("email provider outage"));

    const response = await POST(
      new Request("https://example.com/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: "admin@example.com" }),
      }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE });
    expect(response.status).toBe(200);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
