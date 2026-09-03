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
  /** Non-fatal note about a save that landed (today: a missing audit row). */
  warning?: string;
};

/**
 * Redacts the document to what the caller's role may see, whatever produced it.
 *
 * The write paths hand back the document the service loaded for validation
 * (`includeSettings: true`, every operator's device), so the gate cannot live in
 * `getRoutingDocument` alone: without this the `PUT` response would give a
 * manager the admin-only kill switches they are refused on
 * `/api/telephony/config/settings`.
 */
export function visibleDocument(actor: MotoristActor, document: RoutingDocument): RoutingDocument {
  const manager = canEditConfig(actor.role);
  return {
    ...document,
    settings: actor.role === "admin" ? document.settings : null,
    limits: manager ? document.limits : null,
    operators: manager
      ? document.operators
      : document.operators.map((operator) => (operator.profileId === actor.profileId ? operator : { ...operator, settings: null, device: null })),
  };
}

export function documentResponse(actor: MotoristActor, document: RoutingDocument, warning?: string | null): Response {
  const body: ConfigDocumentResponse = {
    document: visibleDocument(actor, document),
    canEdit: canEditConfig(actor.role),
    canManageSettings: actor.role === "admin",
    ...(warning ? { warning } : {}),
  };
  return Response.json(body, { headers: { "Cache-Control": "private, no-store" } });
}

/**
 * `routingVersion` of the document the editor was working on.
 *
 * Every whole-section `PUT` is a list swap, so a draft built on a stale read
 * would delete the rows a colleague added in the meantime. The version is
 * mandatory on the wire; `motorist_replace_ring_plan` compares it inside the
 * transaction and answers 409 `stale_document`.
 */
export function readExpectedVersion(body: Record<string, unknown>): number {
  const raw = body.version;
  const value = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number.parseInt(raw.trim(), 10) : null;
  if (value === null || !Number.isInteger(value) || value < 0) {
    throw new ConfigServiceError("Chýba verzia konfigurácie. Načítaj nastavenia znova a ulož ich nad aktuálnym stavom.", 400, "version_required");
  }
  return value;
}

/**
 * `GET` of every config route: one read model for all editors, because they
 * cross-reference each other (a step needs its group, a line needs its plan,
 * its IVR menu and its business hours).
 */
export async function handleConfigRead(options: { roles?: AppRole[]; fallback: string } = { fallback: "Konfiguráciu sa nepodarilo načítať." }): Promise<Response> {
  try {
    const actor = await requireDefaultMotoristActor(options.roles ?? CONFIG_READ_ROLES);
    // Three visibility levels in one read model:
    // - the kill switches and the caps are admin-only, exactly like
    //   `/api/telephony/config/settings` (a manager refused there must not read
    //   them out of this response instead);
    // - the routing caps and the destination allowlist are manager-level,
    //   because the group and plan editors pre-validate against them;
    // - another operator's device identity is manager-level too; a dispatcher
    //   sees only their own row.
    const document = await getRoutingDocument(configDeps(), {
      organizationId: actor.organizationId,
      includeSettings: actor.role === "admin",
      includeLimits: canEditConfig(actor.role),
      includeOperatorDetails: canEditConfig(actor.role),
      viewerProfileId: actor.profileId,
    });
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
