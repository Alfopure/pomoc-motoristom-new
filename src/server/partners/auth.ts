import 'server-only';
import type { PartnerActor } from '@/domain/partners';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { resolveDefaultOrganizationId } from '@/server/default-organization';
import { MutationError } from '@/server/mutation-error';
import { partnerAdmin, partnerCheck } from './client';
export async function requirePartnerActor(allowInvited = false): Promise<PartnerActor> {
  const session = await createSupabaseServerClient();
  const { data, error } = await session.auth.getUser();
  if (error || !data.user) throw new MutationError('Prihláste sa do partnerského portálu.', 401);
  const organizationId = await resolveDefaultOrganizationId();
  const result = await partnerAdmin().rpc('motorist_partner_actor', { p_user_id: data.user.id, p_organization_id: organizationId, p_allow_invited: allowInvited });
  partnerCheck(result.error);
  if (!result.data) throw new MutationError('Nemáte aktívny partnerský prístup.', 403);
  return result.data as PartnerActor;
}
export async function getPartnerAuthState() { try { return { authorized: true as const, actor: await requirePartnerActor() }; } catch { return { authorized: false as const }; } }
export async function markPartnerPasswordCompleted(invitationId?: string | null) {
  const actor = await requirePartnerActor(true);
  const result = await partnerAdmin().rpc('motorist_partner_accept', { p_user_id: actor.userId, p_organization_id: actor.organizationId, p_membership_version: actor.version, p_invitation_id: invitationId || null });
  partnerCheck(result.error);
}
