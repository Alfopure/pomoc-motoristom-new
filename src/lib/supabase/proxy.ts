import { createServerClient, type SetAllCookies } from "@supabase/ssr";
import { isAuthApiError, isAuthError, isAuthRetryableFetchError } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { assertAppEnvironment } from "@/lib/app-environment";
import { getSupabasePublicEnv } from "./env";

/** The session cookie `sb-<ref>-auth-token`, also chunked as `.0`, `.1`, …; the PKCE verifier alone is no session. */
const SESSION_COOKIE = /^sb-.+-auth-token(?:\.\d+)?$/;

/** While Auth fails, auth-js retries a refresh for about 25 s; a page never waits longer than this for it. */
export const SESSION_REFRESH_BUDGET_MS = 2_500;

type PendingWrite = { cookies: Parameters<SetAllCookies>[0]; headers: Record<string, string> };

export function hasSupabaseSessionCookie(request: Pick<NextRequest, "cookies">): boolean {
  return request.cookies.getAll().some(({ name }) => SESSION_COOKIE.test(name));
}

/**
 * A failure that says nothing about the session: network, rate limit, Auth
 * server error or an unreadable answer. auth-js still signs out on all but the
 * network case; definitive 4xx answers (already used, not found) do sign out.
 */
function transientAuthFailure(error: unknown): boolean {
  return isAuthRetryableFetchError(error) || (isAuthError(error) && error.name === "AuthUnknownError")
    || (isAuthApiError(error) && (error.status === 429 || error.status >= 500));
}

/**
 * Renews an expiring Supabase session before a page renders and writes the new
 * cookies to both the rendered request and the browser.
 *
 * Server Components cannot write cookies, so each render used to refresh with
 * the same refresh token and drop the result; the browser's next refresh with
 * that token then failed as `refresh_token_already_used`.
 *
 * Never redirects or blocks: pages, routes and RPCs keep authorizing every
 * request. Without a session cookie or a usable environment, after the budget,
 * or when a transient Auth failure would only sign the user out, the request
 * passes unchanged.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const unchanged = NextResponse.next();
  if (!hasSupabaseSessionCookie(request)) return unchanged;
  const env = getSupabasePublicEnv();
  if (!env) return unchanged;
  let pending: PendingWrite | null = null;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    assertAppEnvironment();
    // A new client per request (Fluid compute shares the process).
    const supabase = createServerClient(env.url, env.publicKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        // Held until getClaims settles; a write after the budget is dropped.
        setAll(cookiesToSet, headers) {
          if (!settled) pending = { cookies: [...(pending?.cookies ?? []), ...cookiesToSet], headers: { ...pending?.headers, ...headers } };
        },
      },
    });
    // Nothing may run between createServerClient and getClaims (Supabase SSR):
    // getClaims refreshes an expiring session through setAll above.
    const outcome = await Promise.race([
      supabase.auth.getClaims().then(({ error }) => ({ error }), (error: unknown) => ({ error })),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), SESSION_REFRESH_BUDGET_MS); }),
    ]);
    settled = true;
    // Assigned in setAll; control flow cannot see that.
    const write = pending as PendingWrite | null;
    if (!outcome || !write) return unchanged;
    if (transientAuthFailure(outcome.error) && write.cookies.every(({ value, options }) => !value || options?.maxAge === 0)) return unchanged;
    write.cookies.forEach(({ name, value }) => request.cookies.set(name, value));
    const response = NextResponse.next({ request });
    write.cookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
    Object.entries(write.headers).forEach(([key, value]) => response.headers.set(key, value));
    return response;
  } catch {
    // The page itself reports an unusable session or environment.
    return unchanged;
  } finally {
    settled = true;
    clearTimeout(timer);
  }
}
