import { describe, expect, it, vi } from "vitest";

import { signOutCurrentSession, type CurrentSessionSignOutClient } from "./sign-out";

describe("signOutCurrentSession", () => {
  it("ends only the current device session and returns to the login entry", async () => {
    const signOut = vi.fn(async () => ({ error: null }));
    const navigate = vi.fn();

    await signOutCurrentSession({ auth: { signOut } }, navigate);

    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("does not navigate when the auth provider rejects sign-out", async () => {
    const providerError = new Error("provider unavailable");
    const client: CurrentSessionSignOutClient = {
      auth: { signOut: vi.fn(async () => ({ error: providerError })) },
    };
    const navigate = vi.fn();

    await expect(signOutCurrentSession(client, navigate)).rejects.toBe(providerError);
    expect(navigate).not.toHaveBeenCalled();
  });
});
