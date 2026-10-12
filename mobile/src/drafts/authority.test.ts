import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { AuthIncarnation } from "../lib/auth-incarnation";
import { MobileApiError } from "../lib/api";
import { DraftAuthority, DraftScopeSuperseded } from "./authority";
const user = "00000000-0000-4000-8000-000000000001", organizationA = "00000000-0000-4000-8000-000000000002", organizationB = "00000000-0000-4000-8000-000000000003";
const scope = (organizationId: string) => ({ ok: true as const, apiVersion: 1 as const, environment: "test" as const, profileId: user, organizationId, checkedAt: "2026-10-12T14:00:00Z" });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
describe("ordered private draft authority", () => {
  it("an old background scope success cannot undo a newer organization read", async () => {
    const old = deferred<ReturnType<typeof scope>>(), fetch = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(scope(organizationB));
    const authority = new DraftAuthority(fetch, () => user, user), query = new QueryClient({ defaultOptions: { queries: { retry: false } } }), key = ["scope"];
    const background = query.fetchQuery({ queryKey: key, queryFn: () => authority.read() }); const rejected = expect(background).rejects.toBeInstanceOf(DraftScopeSuperseded);
    const fresh = await authority.read(); query.setQueryData(key, fresh); old.resolve(scope(organizationA)); await rejected;
    expect(authority.snapshot().scope?.organizationId).toBe(organizationB); expect(authority.current(organizationA)).toBe(false); expect(authority.current(organizationB)).toBe(true); expect(query.getQueryData(key)).toEqual(fresh); query.clear(); authority.dispose();
  });
  it("an old success cannot reopen private data after a newer denial", async () => {
    const old = deferred<ReturnType<typeof scope>>(), fetch = vi.fn().mockResolvedValueOnce(scope(organizationA)).mockReturnValueOnce(old.promise).mockRejectedValueOnce(new MobileApiError("denied", 403));
    const authority = new DraftAuthority(fetch, () => user, user); await authority.read(); const stale = authority.read(), rejected = expect(stale).rejects.toBeInstanceOf(DraftScopeSuperseded);
    await expect(authority.read()).rejects.toMatchObject({ status: 403 }); expect(authority.current(organizationA)).toBe(false);
    old.resolve(scope(organizationA)); await rejected; expect(authority.snapshot()).toMatchObject({ scope: null, error: { status: 403 } }); authority.dispose();
  });
  it("an old rejection cannot revoke newer valid authority", async () => {
    const old = deferred<ReturnType<typeof scope>>(), authority = new DraftAuthority(vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(scope(organizationB)), () => user, user);
    const stale = authority.read(), rejected = expect(stale).rejects.toBeInstanceOf(DraftScopeSuperseded); await authority.read(); old.reject(new MobileApiError("old denial", 401)); await rejected;
    expect(authority.snapshot()).toMatchObject({ scope: { organizationId: organizationB }, error: null }); authority.dispose();
  });
  it("same-user token refresh preserves the session; A to null to A cannot revive a deferred old operation", async () => {
    const auth = new AuthIncarnation(); auth.observe(user); const epoch = auth.snapshot().epoch, old = deferred<ReturnType<typeof scope>>();
    const liveUser = () => auth.current(user, epoch) ? user : null, authority = new DraftAuthority(() => old.promise, liveUser, user);
    expect(auth.observe(user)).toBe(false); expect(auth.current(user, epoch)).toBe(true);
    const pending = authority.read(), rejection = expect(pending).rejects.toMatchObject({ status: 401 }); auth.observe(null); auth.observe(user); old.resolve(scope(organizationA)); await rejection;
    expect(authority.snapshot().scope).toBeNull(); expect(liveUser()).toBeNull(); expect(auth.snapshot().epoch).toBe(epoch + 2); authority.dispose();
  });
  it("temporary disconnection keeps private editing access but the actual preflight still rejects", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(scope(organizationA)).mockRejectedValueOnce(new MobileApiError("offline", 0)), authority = new DraftAuthority(fetch, () => user, user);
    await authority.read(); await expect(authority.read()).rejects.toMatchObject({ status: 0 }); expect(authority.current(organizationA)).toBe(true); expect(authority.snapshot().error).toMatchObject({ status: 0 }); authority.dispose();
  });
});
