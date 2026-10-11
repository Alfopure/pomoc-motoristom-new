import "server-only";

import { createClient } from "@supabase/supabase-js";
import { assertAppEnvironment, resolveAppEnvironment } from "@/lib/app-environment";
import { requireSupabasePublicEnv } from "@/lib/supabase/env";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/telephony/uuid";
import type { MobileEnvironment } from "@/lib/mobile-api";
import type { MotoristActor } from "@/server/api-auth";
import { resolveDefaultOrganizationId } from "@/server/default-organization";
import { MutationError } from "@/server/mutation-error";

export const MOBILE_ROLES = ["dispatcher", "senior_dispatcher", "manager", "admin"] as const;

export function mobileEnvironment(): MobileEnvironment {
  return resolveAppEnvironment() === "production" ? "production" : "test";
}

/** Syntax/algorithm rejection only; these unverified values never grant access. */
function isUserJwtShape(token: string): boolean {
  try {
    const [header, payload] = token.split(".").slice(0, 2).map(part => JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
    return Boolean(header && payload && !Array.isArray(header) && !Array.isArray(payload)
      && ["ES256", "RS256", "HS256"].includes(header.alg) && typeof payload.sub === "string"
      && typeof payload.exp === "number" && Number.isFinite(payload.exp));
  } catch { return false; }
}

/** User JWT only. No cookie, machine-secret or development-bypass fallback. */
export async function requireMobileActor(request: Request): Promise<MotoristActor> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.length <= 8192 && /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header);
  if (!match || !isUserJwtShape(match[1])) throw new MutationError("Prihláste sa do aplikácie.", 401);

  assertAppEnvironment();
  if (request.headers.get("x-pm-app-environment") !== mobileEnvironment()) {
    throw new MutationError("Aplikácia je pripojená k nesprávnemu prostrediu.", 409);
  }
  const { url, publicKey } = requireSupabasePublicEnv();
  const authClient = createClient(url, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5_000) }) },
  });
  // Verify the signature against this project's JWKS (Auth for symmetric
  // tokens). Expiry is mandatory below: the SDK's own expiry check throws an
  // untyped Error, which would otherwise turn a normal expired login into 503.
  const { data, error } = await authClient.auth.getClaims(match[1], { allowExpired: true });
  if (error && ((error.status ?? 0) >= 500 || error.name === "AuthRetryableFetchError")) {
    throw new MutationError("Prihlásenie sa momentálne nepodarilo overiť. Skúste znova.", 503);
  }
  const claims = data?.claims;
  const audience = claims?.aud;
  if (error || !claims || !isUuid(claims.sub) || claims.iss !== url.replace(/\/$/, "") + "/auth/v1"
    || claims.role !== "authenticated"
    || !(audience === "authenticated" || Array.isArray(audience) && audience.includes("authenticated"))
    || typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) {
    throw new MutationError("Prihlásenie vypršalo. Prihláste sa znova.", 401);
  }

  const organizationId = await resolveDefaultOrganizationId();
  const { data: profile, error: profileError } = await createSupabaseAdminClient()
    .from("motorist_profiles").select("id,display_name,email,role")
    .eq("organization_id", organizationId).eq("user_id", claims.sub)
    .eq("active", true).eq("access_status", "active").neq("kind", "ai").maybeSingle();
  if (profileError) throw new MutationError("Oprávnenie sa nepodarilo overiť.", 503);
  if (!profile || !MOBILE_ROLES.includes(profile.role)) {
    throw new MutationError("Nemáte prístup k mobilnému dispečingu.", 403);
  }
  return {
    userId: claims.sub, profileId: profile.id, organizationId,
    displayName: profile.display_name, role: profile.role,
    email: profile.email ?? (typeof claims.email === "string" ? claims.email : undefined),
  };
}
