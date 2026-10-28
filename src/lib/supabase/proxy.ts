import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { assertAppEnvironment } from "@/lib/app-environment";
import { getSupabasePublicEnv } from "./env";

/** The session cookie `sb-<ref>-auth-token`, also chunked as `.0`, `.1`, …; the PKCE verifier alone is no session. */
const SESSION_COOKIE = /^sb-.+-auth-token(?:\.\d+)?$/;

export function hasSupabaseSessionCookie(request: Pick<NextRequest, "cookies">): boolean {
  return request.cookies.getAll().some(({ name }) => SESSION_COOKIE.test(name));
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
 * request. Without a session cookie or a usable environment it does nothing.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  // Request headers are forwarded only once setAll changed the cookies.
  let response = NextResponse.next();
  if (!hasSupabaseSessionCookie(request)) return response;
  const env = getSupabasePublicEnv();
  if (!env) return response;
  try {
    assertAppEnvironment();
    // A new client per request (Fluid compute shares the process).
    const supabase = createServerClient(env.url, env.publicKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
          Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
        },
      },
    });
    // Nothing may run between createServerClient and getClaims (Supabase SSR):
    // getClaims refreshes an expiring session through setAll above.
    await supabase.auth.getClaims();
  } catch {
    // The page itself reports an unusable session or environment.
  }
  return response;
}
