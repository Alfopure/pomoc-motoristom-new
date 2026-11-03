import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { TowingCapability, TowingMember } from '@/domain/towing/types';
import { towingAdmin } from './client';
import { mapRpcError, TowingError } from './http';

export function towingEnabled() { return process.env.MOTORIST_TOWING_ENABLED === 'true'; }
export function assertTowingEnabled() { if (!towingEnabled()) throw new TowingError('disabled', 404, 'Modul zákaziek nie je zapnutý.'); }
export type TowingAuthState = { authorized: true; actor: TowingMember } | { authorized: false; reason: string; message: string };
export async function requireTowingActor(capability?: TowingCapability): Promise<TowingMember> { return resolveTowingActor(undefined, capability); }
export async function requireTowingRequestActor(request: Request, capability?: TowingCapability): Promise<TowingMember> { return resolveTowingActor(request, capability); }
async function resolveTowingActor(request: Request | undefined, capability?: TowingCapability): Promise<TowingMember> {
  assertTowingEnabled();
  const session = await createSupabaseServerClient();
  const { data, error } = await session.auth.getUser();
  if (error || !data.user) throw new TowingError('unauthenticated', 401, 'Prihláste sa do aplikácie.');
  const expectedUser = request?.headers.get('x-towing-user');
  if (expectedUser && expectedUser !== data.user.id) throw new TowingError('identity_changed',401,'Prihlásený účet sa zmenil.');
  const result = await towingAdmin().rpc('motorist_towing_actor', { p_user_id: data.user.id });
  mapRpcError(result.error);
  const actor = result.data as TowingMember | null;
  if (!actor?.active || actor.userId !== data.user.id || !actor.organizationId || !Array.isArray(actor.capabilities))
    throw new TowingError('membership_revoked', 403, 'Nemáte aktívny prístup k zákazkám.');
  if (capability && !actor.capabilities.includes(capability)) throw new TowingError('access_denied', 403, 'Na túto operáciu nemáte oprávnenie.');
  return actor;
}
export async function getTowingAuthState(): Promise<TowingAuthState> {
  try { return { authorized: true, actor: await requireTowingActor() }; }
  catch (error) { return { authorized: false, reason: error instanceof TowingError ? error.code : 'unavailable', message: error instanceof TowingError ? error.message : 'Zákazky momentálne nie sú dostupné.' }; }
}
/** Office first, then towing driving, then the shared field workspace. */
export function towingLoginDestination(actor: TowingMember): "/zakazky" | "/vodic" | "/moje-jazdy" | "/pobocka" | null {
  if (actor.capabilities.some(capability => capability !== 'drive' && capability !== 'deliver')) return '/zakazky';
  if (actor.roles?.includes('branch')) return '/pobocka';
  if (actor.capabilities.includes('drive')) return '/vodic';
  return actor.capabilities.includes('deliver') ? '/moje-jazdy' : null;
}
export async function markTowingPasswordCompleted() {
  const actor = await requireTowingActor();
  const result = await towingAdmin().rpc('motorist_towing_password_completed', { p_user_id: actor.userId });
  mapRpcError(result.error);
}
export function actorRpcParams(actor: TowingMember) {
  return { p_user_id: actor.userId, p_organization_id: actor.organizationId, p_membership_version: actor.version };
}
