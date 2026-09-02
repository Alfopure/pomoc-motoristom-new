import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

import { resolveDefaultOrganizationId } from "./default-organization";
import { MutationError } from "./motorist-mutations";

type MotoristRole = Database["public"]["Tables"]["motorist_profiles"]["Row"]["role"];

export { resolveDefaultOrganizationId } from "./default-organization";

export type MotoristActor = {
  userId: string;
  profileId: string;
  organizationId: string;
  displayName: string;
  role: MotoristRole;
  email?: string;
};

export type MotoristAuthState =
  | { authorized: true; profile?: MotoristActor }
  | { authorized: false; reason: "unauthenticated" | "missing_profile" | "insufficient_role" | "configuration_error"; message: string };

/**
 * Dev-only auth bypass. It must be enabled explicitly so that a normal
 * `npm run dev` session still resolves the actor from the signed-in user.
 * Playwright enables it explicitly for isolated browser tests.
 */
function devAuthBypass(): boolean {
  return process.env.MOTORIST_DEV_AUTH_BYPASS === "true";
}

/**
 * Route guard: overí prihlásenie (a voliteľne rolu) a pri neúspechu vráti hotový Response,
 * inak null. Použitie v handleri: `const denied = await motoristAccessGuard(); if (denied) return denied;`.
 * Zjednocuje zavretie anonymného prístupu na API routes (bezpečnostný audit, Milestone 1).
 *
 * Ak sa odovzdá `request`, spustí sa CSRF same-origin kontrola (`assertSameOriginRequest`) PRED auth —
 * mismatch Origin → 403, matching same-origin anon → padne na auth (401/403). Použi pri mutačných
 * (POST/PATCH/DELETE) session routes (bezpečnostný audit, Milestone 1, task 1.4).
 */
export async function motoristAccessGuard(options?: { roles?: MotoristRole[]; request?: Request }): Promise<Response | null> {
  try {
    if (options?.request) {
      assertSameOriginRequest(options.request);
    }
    if (options?.roles && options.roles.length > 0) {
      await requireDefaultMotoristOrgRole(options.roles);
    } else {
      await requireDefaultMotoristOrgMember();
    }
    return null;
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "Oprávnenie sa nepodarilo overiť." }, { status: 500 });
  }
}

export async function requireDefaultMotoristOrgMember() {
  if (devAuthBypass()) {
    return;
  }

  await requireDefaultMotoristOrgRole();
}

export async function requireDefaultMotoristOrgRole(roles?: MotoristRole[]) {
  if (devAuthBypass()) {
    return;
  }

  const organizationId = await resolveDefaultOrganizationId();
  await requireMotoristOrgMember(organizationId, roles);
}

export async function requireDefaultMotoristActor(roles: MotoristRole[] = ["manager", "admin"]): Promise<MotoristActor> {
  const organizationId = await resolveDefaultOrganizationId();
  return requireMotoristActor(organizationId, roles);
}

export async function requireMotoristActor(organizationId: string, roles?: MotoristRole[]): Promise<MotoristActor> {
  if (devAuthBypass()) {
    const actor = await getDevelopmentActor(organizationId, roles);

    if (actor) {
      return actor;
    }
  }

  const authState = await getMotoristAuthState(organizationId, roles);

  if (authState.authorized && authState.profile) {
    return authState.profile;
  }

  if (!authState.authorized && authState.reason === "unauthenticated") {
    throw new MutationError(authState.message, 401);
  }

  if (!authState.authorized && (authState.reason === "insufficient_role" || authState.reason === "missing_profile")) {
    throw new MutationError(authState.message, 403);
  }

  throw new MutationError(authState.authorized ? "Oprávnenie sa nepodarilo overiť." : authState.message, 500);
}

export async function requireMotoristOrgMember(organizationId: string, roles?: MotoristRole[]) {
  if (devAuthBypass()) {
    return;
  }

  const authState = await getMotoristAuthState(organizationId, roles);

  if (authState.authorized) {
    return;
  }

  if (authState.reason === "unauthenticated") {
    throw new MutationError(authState.message, 401);
  }

  if (authState.reason === "insufficient_role" || authState.reason === "missing_profile") {
    throw new MutationError(authState.message, 403);
  }

  throw new MutationError(authState.message, 500);
}

export async function getDefaultMotoristAuthState(roles?: MotoristRole[]): Promise<MotoristAuthState> {
  if (devAuthBypass()) {
    return { authorized: true };
  }

  try {
    const organizationId = await resolveDefaultOrganizationId();
    return await getMotoristAuthState(organizationId, roles);
  } catch {
    return {
      authorized: false,
      reason: "configuration_error",
      message: "Organizácia nie je nakonfigurovaná.",
    };
  }
}

async function getMotoristAuthState(organizationId: string, roles?: MotoristRole[]): Promise<MotoristAuthState> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return {
      authorized: false,
      reason: "unauthenticated",
      message: "Na túto operáciu sa musíš prihlásiť.",
    };
  }

  const { data, error } = await (supabase as SupabaseClient<Database>)
    .from("motorist_profiles")
    .select("id, display_name, role, email")
    .eq("organization_id", organizationId)
    .eq("user_id", user.id)
    .eq("active", true)
    .maybeSingle();

  if (error) {
    return {
      authorized: false,
      reason: "configuration_error",
      message: "Oprávnenie sa nepodarilo overiť.",
    };
  }

  if (!data) {
    return {
      authorized: false,
      reason: "missing_profile",
      message: "Na túto organizáciu nemáš oprávnenie.",
    };
  }

  if (roles && !roles.includes(data.role)) {
    return {
      authorized: false,
      reason: "insufficient_role",
      message: "Na túto operáciu nemáš oprávnenie.",
    };
  }

  return {
    authorized: true,
    profile: {
      userId: user.id,
      profileId: data.id,
      organizationId,
      displayName: data.display_name,
      role: data.role,
      email: data.email ?? user.email ?? undefined,
    },
  };
}

async function getDevelopmentActor(organizationId: string, roles?: MotoristRole[]): Promise<MotoristActor | null> {
  try {
    const admin = createSupabaseAdminClient();
    const allowedRoles = roles && roles.length > 0 ? roles : (["admin", "manager"] as MotoristRole[]);
    const { data } = await admin
      .from("motorist_profiles")
      .select("id, user_id, display_name, role, email")
      .eq("organization_id", organizationId)
      .eq("active", true)
      .in("role", allowedRoles)
      .order("role", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!data) {
      return null;
    }

    return {
      userId: data.user_id ?? "development-user",
      profileId: data.id,
      organizationId,
      displayName: data.display_name,
      role: data.role,
      email: data.email ?? undefined,
    };
  } catch {
    return null;
  }
}

export function assertSameOriginRequest(request: Request) {
  if (devAuthBypass()) {
    return;
  }

  const origin = request.headers.get("origin");

  if (!origin) {
    return;
  }

  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");

  if (!host) {
    throw new MutationError("Požiadavka neprešla bezpečnostnou kontrolou.", 403);
  }

  const proto = request.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  const expectedOrigin = `${proto}://${host}`;

  if (origin !== expectedOrigin) {
    throw new MutationError("Požiadavka neprešla bezpečnostnou kontrolou.", 403);
  }
}
