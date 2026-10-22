import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canOperateTelephony } from "@/lib/app-environment";
import type { MobileFieldScope } from "@/lib/mobile-api";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/telephony/uuid";
import { MutationError } from "@/server/mutation-error";
import type { MotoristActor } from "@/server/api-auth";
import { mobileEnvironment, requireMobileActor, verifyMobileUser } from "./auth";

/** A pristavovač: a field member (no dispatch profile) who may receive deliveries. */
export type MobileFieldActor = { userId: string; memberId: string; organizationId: string; displayName: string; email: string | null; version: number };

/** Deliveries to pristavovači in the app. Like telephony, never from a working-branch
 * Preview, and on TEST only from the dedicated stable TEST deployment. */
export function mobileDeliveryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MOBILE_DELIVERY_ENABLED === "true" && canOperateTelephony(env);
}
export const deliveryUnavailable = () => new MutationError("Pristavenia ešte nie sú v tomto prostredí zapnuté.", 503, "delivery_unavailable");
export const missingSchema = (code: string | undefined) => ["PGRST202", "PGRST205", "42883", "42P01"].includes(code ?? "");
/** Field-member RPCs are not in the generated dispatch types. */
export const fieldAdmin = () => createSupabaseAdminClient() as unknown as SupabaseClient;

/** User JWT and an active field membership with the delivery capability. */
export async function requireMobileFieldActor(request: Request): Promise<MobileFieldActor> {
  const user = await verifyMobileUser(request);
  if (!mobileDeliveryEnabled()) throw deliveryUnavailable();
  const { data, error } = await fieldAdmin().rpc("motorist_towing_actor", { p_user_id: user.userId });
  if (error) {
    if (missingSchema(error.code)) throw deliveryUnavailable();
    if (error.code === "42501") throw new MutationError("Nemáte prístup k pristaveniam.", 403, "mobile_no_field_access");
    throw new MutationError("Oprávnenie sa nepodarilo overiť.", 503);
  }
  const member = data as { id?: unknown; userId?: unknown; organizationId?: unknown; displayName?: unknown; email?: unknown; active?: unknown; version?: unknown; capabilities?: unknown } | null;
  if (!member || member.active !== true || member.userId !== user.userId || typeof member.organizationId !== "string"
    || member.organizationId.toLowerCase() !== user.organizationId.toLowerCase() || !Array.isArray(member.capabilities) || !member.capabilities.includes("deliver")
    || typeof member.id !== "string" || !isUuid(member.id) || typeof member.displayName !== "string" || typeof member.version !== "number" || !Number.isSafeInteger(member.version)) {
    throw new MutationError("Nemáte prístup k pristaveniam.", 403, "mobile_no_field_access");
  }
  if (user.expectedOrganization !== null && user.expectedOrganization.toLowerCase() !== user.organizationId.toLowerCase()) {
    throw new MutationError("Organizácia účtu sa zmenila. Obnovte prihlásenie pred pokračovaním.", 409, "expected_organization_mismatch");
  }
  return { userId: user.userId, memberId: member.id.toLowerCase(), organizationId: user.organizationId, displayName: member.displayName,
    email: typeof member.email === "string" ? member.email : user.email ?? null, version: member.version };
}

export function fieldScope(actor: MobileFieldActor): MobileFieldScope {
  return { ok: true, apiVersion: 1, environment: mobileEnvironment(), memberId: actor.memberId, checkedAt: new Date().toISOString() };
}

/** A dispatcher, a pristavovač or both (one app with both modules), for what they
 * share: their phone's notifications. At least one of the two is present. */
export type MobilePerson = { dispatcher: MotoristActor; field: MobileFieldActor | null } | { dispatcher: null; field: MobileFieldActor };
export async function requireMobilePerson(request: Request): Promise<MobilePerson> {
  let dispatcher: MotoristActor | null = null;
  try { dispatcher = await requireMobileActor(request); }
  catch (error) { if (!(error instanceof MutationError) || error.code !== "mobile_no_dispatch_profile") throw error; }
  if (!dispatcher) return { dispatcher: null, field: await requireMobileFieldActor(request) };
  // Without deliveries (switched off, no delivery role, a passing failure) a
  // dispatcher stays a dispatcher.
  if (!mobileDeliveryEnabled()) return { dispatcher, field: null };
  try { return { dispatcher, field: await requireMobileFieldActor(request) }; }
  catch { return { dispatcher, field: null }; }
}
