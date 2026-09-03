import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { AppRole } from "@/domain/types";
import { assertSameOriginRequest, requireDefaultMotoristActor, type MotoristActor } from "@/server/api-auth";

import { ConfigServiceError, getRoutingDocument, type ConfigActor, type ConfigDeps, type RoutingDocument } from "./config-service";
import { readJsonBody, telephonyErrorResponse } from "./runtime";

/**
 * Shared body of the `/api/telephony/config/*` routes (design §4 Phase 3).
 *
 * Role contract: reading is member level, writing is manager/admin, and the
 * organisation settings route (kill switches, destination allowlist, park
 * limit) is admin only. Mutations run `assertSameOriginRequest` before the
 * session guard so a mismatched Origin is 403 even for an anonymous request
 * (`route-csrf.test.ts`).
 *
 * These routes never touch Telnyx, so they deliberately skip the
 * "telephony not configured" gate: the routing document has to be editable
 * before the provider keys are in place.
 */

export const CONFIG_READ_ROLES: AppRole[] = ["dispatcher", "senior_dispatcher", "manager", "admin"];
export const CONFIG_WRITE_ROLES: AppRole[] = ["manager", "admin"];
export const CONFIG_ADMIN_ROLES: AppRole[] = ["admin"];

export function canEditConfig(role: AppRole): boolean {
  return role === "manager" || role === "admin";
}

export function configDeps(): ConfigDeps {
  return { admin: createSupabaseAdminClient() };
}

export function toConfigActor(actor: MotoristActor): ConfigActor {
  return { profileId: actor.profileId, role: actor.role, displayName: actor.displayName };
}

/** Maps `ConfigServiceError` (with its validation issues) onto a response. */
export function configErrorResponse(error: unknown, fallback: string): Response {
  if (error instanceof ConfigServiceError) {
    return Response.json({ error: error.message, code: error.code, ...(error.issues.length > 0 ? { issues: error.issues } : {}) }, { status: error.status });
  }
  return telephonyErrorResponse(error, fallback);
}

export type ConfigDocumentResponse = {
  document: RoutingDocument;
  canEdit: boolean;
  canManageSettings: boolean;
};

export function documentResponse(actor: MotoristActor, document: RoutingDocument): Response {
  const body: ConfigDocumentResponse = { document, canEdit: canEditConfig(actor.role), canManageSettings: actor.role === "admin" };
  return Response.json(body, { headers: { "Cache-Control": "private, no-store" } });
}

/**
 * `GET` of every config route: one read model for all editors, because they
 * cross-reference each other (a step needs its group, a line needs its plan,
 * its IVR menu and its business hours).
 */
export async function handleConfigRead(options: { roles?: AppRole[]; fallback: string } = { fallback: "Konfiguráciu sa nepodarilo načítať." }): Promise<Response> {
  try {
    const actor = await requireDefaultMotoristActor(options.roles ?? CONFIG_READ_ROLES);
    const document = await getRoutingDocument(configDeps(), { organizationId: actor.organizationId, includeSettings: canEditConfig(actor.role) });
    return documentResponse(actor, document);
  } catch (error) {
    return configErrorResponse(error, options.fallback);
  }
}

export type ConfigWriteInput = {
  deps: ConfigDeps;
  actor: MotoristActor;
  configActor: ConfigActor;
  body: Record<string, unknown>;
  organizationId: string;
};

/** `PUT`/`PATCH` of every config route: CSRF, then role gate, then the service call. */
export async function handleConfigWrite(
  request: Request,
  options: { roles?: AppRole[]; fallback: string; run: (input: ConfigWriteInput) => Promise<Response> },
): Promise<Response> {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(options.roles ?? CONFIG_WRITE_ROLES);
    const body = await readJsonBody(request);
    return await options.run({
      deps: configDeps(),
      actor,
      configActor: toConfigActor(actor),
      body,
      organizationId: actor.organizationId,
    });
  } catch (error) {
    return configErrorResponse(error, options.fallback);
  }
}
