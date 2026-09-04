import "server-only";

import type { User } from "@supabase/supabase-js";
import type { AccessStatus, AppRole } from "@/domain/types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Database, Json } from "@/lib/supabase/database.types";
import { buildAppUrl, escapeHtml, requestOrigin, sendEmail, type EmailDeliveryResult } from "./email-delivery";
import { canAssignRole, canManageTargetRole, isAppRole } from "./access-policy";
import { type MotoristActor, resolveDefaultOrganizationId } from "./api-auth";
import { assertRateLimit, rateLimitKey, requestIp } from "./rate-limit";
import { MutationError } from "./motorist-mutations";

type Tables = Database["public"]["Tables"];
type ProfileRow = Tables["motorist_profiles"]["Row"];
type EmailPurpose = Tables["motorist_auth_email_events"]["Row"]["purpose"];

export const FORGOT_PASSWORD_GENERIC_MESSAGE = "Ak účet existuje, poslali sme email na obnovu hesla.";

export function forgotPasswordGenericResult() {
  return { ok: true, message: FORGOT_PASSWORD_GENERIC_MESSAGE };
}

export type CreateAccessUserInput = {
  displayName?: string;
  email?: string;
  role?: AppRole;
  sendInvite?: boolean;
};

export type UpdateAccessUserInput = {
  displayName?: string;
  email?: string;
  role?: AppRole;
  active?: boolean;
};

export async function createAccessUser(actor: MotoristActor, input: CreateAccessUserInput, request?: Request) {
  const supabase = createSupabaseAdminClient();
  const displayName = cleanString(input.displayName);
  const email = normalizeEmail(input.email);
  const role = input.role ?? "dispatcher";

  if (!displayName) {
    throw new MutationError("Zadaj meno používateľa.", 400);
  }

  if (!email) {
    throw new MutationError("Zadaj email používateľa.", 400);
  }

  if (!isEmail(email)) {
    throw new MutationError("Email nemá správny formát.", 400);
  }

  if (!isAppRole(role) || !canAssignRole(actor.role, role)) {
    throw new MutationError("Túto rolu nemôžeš priradiť.", 403);
  }

  const duplicate = await supabase
    .from("motorist_profiles")
    .select("id")
    .eq("organization_id", actor.organizationId)
    .eq("email", email)
    .maybeSingle();

  if (duplicate.error) {
    throw new MutationError("Email sa nepodarilo overiť.", 500);
  }

  if (duplicate.data) {
    throw new MutationError("Používateľ s týmto emailom už existuje.", 409);
  }

  const { data, error } = await supabase
    .from("motorist_profiles")
    .insert({
      organization_id: actor.organizationId,
      display_name: displayName,
      email,
      role,
      active: true,
      access_status: "not_invited",
    })
    .select("*")
    .single();

  if (error) {
    throw new MutationError("Používateľa sa nepodarilo vytvoriť.", 500);
  }

  let notice: string | undefined;

  if (input.sendInvite !== false) {
    try {
      await sendAccessLink(actor, data.id, "invite", request);
      notice = "Používateľ je vytvorený a prístup bol odoslaný.";
    } catch (errorToReport) {
      notice = errorToReport instanceof Error ? `Používateľ je vytvorený, ale prístup sa nepodarilo odoslať: ${errorToReport.message}` : "Používateľ je vytvorený, ale prístup sa nepodarilo odoslať.";
    }
  }

  return { profile: data, notice };
}

export async function updateAccessUser(actor: MotoristActor, profileId: string, input: UpdateAccessUserInput) {
  const supabase = createSupabaseAdminClient();
  const profile = await getManagedProfile(actor, profileId);
  const nextRole = input.role ?? profile.role;

  if (!isAppRole(nextRole) || !canAssignRole(actor.role, nextRole)) {
    throw new MutationError("Túto rolu nemôžeš priradiť.", 403);
  }

  if (!canManageTargetRole(actor.role, profile.role)) {
    throw new MutationError("Tento profil nemôžeš upraviť.", 403);
  }

  const nextActive = input.active ?? profile.active;
  await assertNotLastAdminLoss(profile, { role: nextRole, active: nextActive });

  const nextEmail = input.email === undefined ? profile.email : normalizeEmail(input.email);

  if (nextEmail && !isEmail(nextEmail)) {
    throw new MutationError("Email nemá správny formát.", 400);
  }

  if (nextEmail && nextEmail !== profile.email) {
    await assertEmailIsAvailable(actor.organizationId, nextEmail, profile.id);

    if (profile.user_id) {
      const { error } = await supabase.auth.admin.updateUserById(profile.user_id, {
        email: nextEmail,
        email_confirm: true,
        user_metadata: { display_name: input.displayName ?? profile.display_name },
      });

      if (error) {
        throw new MutationError(`Email v Supabase Auth sa nepodarilo zmeniť: ${error.message}`, 500);
      }
    }
  }

  const patch: Tables["motorist_profiles"]["Update"] = {
    ...(input.displayName !== undefined ? { display_name: cleanString(input.displayName) } : {}),
    ...(input.email !== undefined ? { email: nextEmail || null } : {}),
    ...(input.role !== undefined ? { role: nextRole } : {}),
  };

  if (input.active !== undefined) {
    patch.active = input.active;
    patch.access_status = input.active ? nextEnabledStatus(profile) : "disabled";
    patch.access_disabled_at = input.active ? null : new Date().toISOString();
    patch.access_disabled_by = input.active ? null : actor.profileId;

    if (!input.active && profile.user_id) {
      const { error } = await supabase.auth.admin.updateUserById(profile.user_id, { ban_duration: "876000h" });

      if (error) {
        throw new MutationError(`Auth účet sa nepodarilo deaktivovať: ${error.message}`, 500);
      }
    }

    if (input.active && profile.user_id) {
      const { error } = await supabase.auth.admin.updateUserById(profile.user_id, { ban_duration: "none" });

      if (error) {
        throw new MutationError(`Auth účet sa nepodarilo reaktivovať: ${error.message}`, 500);
      }
    }
  }

  if (patch.display_name !== undefined && !patch.display_name) {
    throw new MutationError("Meno používateľa nemôže byť prázdne.", 400);
  }

  const { data, error } = await supabase.from("motorist_profiles").update(patch).eq("id", profile.id).select("*").single();

  if (error) {
    throw new MutationError("Používateľa sa nepodarilo uložiť.", 500);
  }

  return data;
}

/**
 * Deletes a user for good: the profile row, their Supabase Auth account and
 * their Telnyx credential.
 *
 * Deactivation keeps the person and bans their login; deletion removes them.
 * The database is built for it — every foreign key that points at
 * `motorist_profiles` either cascades (the rows that only describe *them*:
 * devices, presence, ring-group membership, attendance, favourites) or nulls
 * (the rows that describe *work*: cases, calls, tasks, audit). So the centre's
 * history survives a departure and only stops naming the person, which is also
 * what a deletion request under GDPR asks for.
 *
 * Three things must happen outside the row, and in this order:
 *   1. refuse while they are on a live call — deleting mid-call would cut it,
 *   2. delete the Telnyx credential, or a browser still holding a JWT could
 *      keep its SIP registration and be offered calls after the account is gone,
 *   3. delete the Auth user, so the login stops existing rather than merely
 *      losing its profile.
 * The audit row is written first, because `motorist_audit_log.actor_profile_id`
 * survives but the target's name would not.
 */
export async function deleteAccessUser(actor: MotoristActor, profileId: string) {
  const supabase = createSupabaseAdminClient();
  const profile = await getManagedProfile(actor, profileId);

  if (profile.id === actor.profileId) {
    throw new MutationError("Vlastný účet vymazať nemôžeš.", 400);
  }
  if (!canManageTargetRole(actor.role, profile.role)) {
    throw new MutationError("Tento profil nemôžeš vymazať.", 403);
  }
  // Deleting the last admin is the same lockout as deactivating them.
  await assertNotLastAdminLoss(profile, { role: profile.role, active: false });

  const live = await supabase
    .from("motorist_call_legs")
    .select("id")
    .eq("profile_id", profile.id)
    .is("ended_at", null)
    .limit(1);
  if (live.error) {
    throw new MutationError("Stav hovorov používateľa sa nepodarilo overiť.", 500);
  }
  if ((live.data ?? []).length > 0) {
    throw new MutationError("Používateľ je práve v hovore. Skús to znova, keď hovor skončí.", 409);
  }

  await supabase.from("motorist_audit_log").insert({
    organization_id: profile.organization_id,
    actor_profile_id: actor.profileId,
    action: "access.user.delete",
    entity_type: "profile",
    entity_id: profile.id,
    before_payload: {
      display_name: profile.display_name,
      email: profile.email,
      role: profile.role,
      access_status: profile.access_status,
    } as unknown as Json,
    after_payload: null,
  });

  await deleteOperatorCredential(supabase, profile);

  if (profile.user_id) {
    const { error } = await supabase.auth.admin.deleteUser(profile.user_id);
    // "not found" means somebody removed it already; anything else must stop us
    // before the profile row disappears and the login is left behind.
    if (error && !/not.?found/i.test(error.message)) {
      throw new MutationError(`Auth účet sa nepodarilo vymazať: ${error.message}`, 500);
    }
  }

  const { error } = await supabase.from("motorist_profiles").delete().eq("id", profile.id);
  if (error) {
    throw new MutationError("Používateľa sa nepodarilo vymazať.", 500);
  }

  return { deletedProfileId: profile.id };
}

/**
 * Removes the operator's Telnyx credential before the device row cascades away.
 * Best effort by design: telephony may not be configured at all, and a
 * credential Telnyx has already forgotten must not block the deletion — the
 * device row is going anyway, so nothing can mint a new token for it.
 */
async function deleteOperatorCredential(supabase: ReturnType<typeof createSupabaseAdminClient>, profile: ProfileRow) {
  const device = await supabase
    .from("motorist_operator_devices")
    .select("telnyx_credential_id")
    .eq("profile_id", profile.id)
    .not("telnyx_credential_id", "is", null)
    .limit(1)
    .maybeSingle();
  const credentialId = device.data?.telnyx_credential_id;
  if (!credentialId) return;

  try {
    const { getTelnyxConfig } = await import("@/server/telephony/telnyx/env");
    const config = getTelnyxConfig();
    if (!config.configured) return;
    const { createTelnyxClient } = await import("@/server/telephony/telnyx/client");
    const client = createTelnyxClient({ config, liveGate: { callsEnabled: true, smsEnabled: false } });
    await client.deleteTelephonyCredential(credentialId);
  } catch (error) {
    console.error("Telnyx credential deletion during account removal failed:", error);
  }
}

export async function sendAccessLink(actor: MotoristActor, profileId: string, purpose: "invite" | "reset_password", request?: Request) {
  const profile = await getManagedProfile(actor, profileId);

  if (purpose === "reset_password" && profile.access_status !== "active") {
    throw new MutationError("Reset hesla sa dá poslať až aktívnemu používateľovi.", 400);
  }

  if (purpose === "invite" && profile.access_status !== "not_invited" && profile.access_status !== "invited") {
    throw new MutationError("Pozvánku je možné poslať iba používateľovi bez aktívneho prístupu.", 400);
  }

  if (profile.access_status === "disabled") {
    throw new MutationError("Používateľ je deaktivovaný. Najprv ho reaktivuj.", 400);
  }

  assertRateLimit(rateLimitKey("access", purpose, profile.id), {
    limit: 3,
    windowMs: 15 * 60 * 1000,
    message: "Prístup alebo reset bol odoslaný príliš veľakrát. Skús to neskôr.",
  });

  const email = normalizeEmail(profile.email);

  if (!email) {
    throw new MutationError("Používateľ nemá nastavený email.", 400);
  }

  const supabase = createSupabaseAdminClient();
  const link = await generateAccessActionLink(supabase, profile, email, purpose, request);
  const eventPurpose: EmailPurpose = purpose === "reset_password" ? "reset_password" : profile.invite_last_sent_at ? "resend_invite" : "invite";
  const idempotencyKey = await nextEmailIdempotencyKey(profile.id, eventPurpose);
  const delivery = await sendEmail(buildAccessEmail({ email, profile, actionLink: link.actionLink, purpose, idempotencyKey }));

  await recordEmailEvent({
    organizationId: actor.organizationId,
    profileId: profile.id,
    purpose: eventPurpose,
    recipientEmail: email,
    requestedBy: actor.profileId,
    delivery,
    idempotencyKey,
    request,
  });

  if (delivery.status !== "sent") {
    throw new MutationError(delivery.error ?? "Email sa nepodarilo odoslať.", 502);
  }

  const now = new Date().toISOString();
  const patch: Tables["motorist_profiles"]["Update"] =
    purpose === "reset_password"
      ? {}
      : {
          user_id: link.userId,
          active: true,
          access_status: "invited",
          invited_at: profile.invited_at ?? now,
          invite_last_sent_at: now,
          invited_by: actor.profileId,
        };

  if (Object.keys(patch).length > 0) {
    const { error } = await supabase.from("motorist_profiles").update(patch).eq("id", profile.id);

    if (error) {
      throw new MutationError("Stav prístupu sa nepodarilo uložiť.", 500);
    }
  }

  return delivery;
}

export async function sendForgotPassword(emailInput: string | undefined, request: Request) {
  const email = normalizeEmail(emailInput);
  const generic = forgotPasswordGenericResult();

  if (!email || !isEmail(email)) {
    return generic;
  }

  assertRateLimit(rateLimitKey("forgot", requestIp(request), email), {
    limit: 5,
    windowMs: 60 * 60 * 1000,
    message: generic.message,
  });

  const supabase = createSupabaseAdminClient();
  const organizationId = await resolveDefaultOrganizationId();
  const { data: profile } = await supabase
    .from("motorist_profiles")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("email", email)
    .eq("active", true)
    .neq("access_status", "disabled")
    .maybeSingle();

  if (!profile) {
    return generic;
  }

  const link = await generateAccessActionLink(supabase, profile, email, "reset_password", request);
  const idempotencyKey = await nextEmailIdempotencyKey(profile.id, "forgot_password");
  const delivery = await sendEmail(buildAccessEmail({ email, profile, actionLink: link.actionLink, purpose: "reset_password", idempotencyKey }));

  await recordEmailEvent({
    organizationId,
    profileId: profile.id,
    purpose: "forgot_password",
    recipientEmail: email,
    delivery,
    idempotencyKey,
    request,
  });

  return generic;
}

export async function markPasswordCompleted() {
  const organizationId = await resolveDefaultOrganizationId();
  const server = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError,
  } = await server.auth.getUser();

  if (userError || !user) {
    throw new MutationError("Na zmenu hesla sa musíš prihlásiť cez odkaz z emailu.", 401);
  }

  const supabase = createSupabaseAdminClient();
  const { data: profile, error: profileError } = await supabase
    .from("motorist_profiles")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (profileError) {
    throw new MutationError("Profil sa nepodarilo overiť.", 500);
  }

  if (!profile || profile.access_status === "disabled") {
    throw new MutationError("Tento prístup nie je aktívny.", 403);
  }

  const { error } = await supabase
    .from("motorist_profiles")
    .update({
      active: true,
      access_status: "active",
      password_set_at: new Date().toISOString(),
      email: profile.email ?? user.email ?? null,
    })
    .eq("id", profile.id);

  if (error) {
    throw new MutationError("Stav hesla sa nepodarilo uložiť.", 500);
  }
}

async function getManagedProfile(actor: MotoristActor, profileId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from("motorist_profiles").select("*").eq("organization_id", actor.organizationId).eq("id", profileId).maybeSingle();

  if (error) {
    throw new MutationError("Používateľa sa nepodarilo načítať.", 500);
  }

  if (!data) {
    throw new MutationError("Používateľ neexistuje.", 404);
  }

  if (!canManageTargetRole(actor.role, data.role)) {
    throw new MutationError("Tento profil nemôžeš spravovať.", 403);
  }

  return data;
}

async function generateAccessActionLink(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  profile: ProfileRow,
  email: string,
  purpose: "invite" | "reset_password",
  request?: Request,
) {
  const existingUser = profile.user_id ? await getAuthUserById(supabase, profile.user_id) : await findAuthUserByEmail(supabase, email);

  if (existingUser) {
    if (!profile.user_id) {
      const { error } = await supabase.from("motorist_profiles").update({ user_id: existingUser.id }).eq("id", profile.id);

      if (error) {
        throw new MutationError("Auth účet sa nepodarilo prepojiť s profilom.", 500);
      }
    }

    const { data, error } = await supabase.auth.admin.generateLink({
      type: "recovery",
      email,
    });

    if (error) {
      throw new MutationError(`Reset link sa nepodarilo vytvoriť: ${error.message}`, 500);
    }

    return { actionLink: buildTokenHashActionLink(data.properties, request), userId: existingUser.id };
  }

  if (purpose === "reset_password") {
    throw new MutationError("Používateľ ešte nemá vytvorený auth účet. Pošli mu najprv prístup.", 400);
  }

  const { data, error } = await supabase.auth.admin.generateLink({
    type: "invite",
    email,
    options: {
      data: { display_name: profile.display_name },
    },
  });

  if (error) {
    throw new MutationError(`Pozvánku sa nepodarilo vytvoriť: ${error.message}`, 500);
  }

  return { actionLink: buildTokenHashActionLink(data.properties, request), userId: data.user.id };
}

// Odkaz vedie priamo na našu doménu s token_hash namiesto Supabase verify redirectu,
// takže nezávisí od Site URL ani redirect allowlistu v Supabase Auth konfigurácii.
function buildTokenHashActionLink(properties: { hashed_token: string; verification_type: string }, request?: Request) {
  const query = new URLSearchParams({
    token_hash: properties.hashed_token,
    type: properties.verification_type,
    next: "/auth/set-password",
  });

  return buildAppUrl(`/auth/callback?${query.toString()}`, requestOrigin(request));
}

async function findAuthUserByEmail(supabase: ReturnType<typeof createSupabaseAdminClient>, email: string): Promise<User | null> {
  let page = 1;
  const perPage = 1000;

  while (page <= 10) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });

    if (error) {
      throw new MutationError("Auth používateľov sa nepodarilo načítať.", 500);
    }

    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email);

    if (user) {
      return user;
    }

    if (data.users.length < perPage) {
      return null;
    }

    page += 1;
  }

  return null;
}

async function getAuthUserById(supabase: ReturnType<typeof createSupabaseAdminClient>, userId: string): Promise<User | null> {
  const { data, error } = await supabase.auth.admin.getUserById(userId);

  if (error) {
    return null;
  }

  return data.user;
}

async function assertEmailIsAvailable(organizationId: string, email: string, currentProfileId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("motorist_profiles")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("email", email)
    .neq("id", currentProfileId)
    .maybeSingle();

  if (error) {
    throw new MutationError("Email sa nepodarilo overiť.", 500);
  }

  if (data) {
    throw new MutationError("Používateľ s týmto emailom už existuje.", 409);
  }
}

async function assertNotLastAdminLoss(profile: ProfileRow, next: { role: AppRole; active: boolean }) {
  if (profile.role !== "admin" || profile.active === false || (next.role === "admin" && next.active)) {
    return;
  }

  const supabase = createSupabaseAdminClient();
  const { count, error } = await supabase
    .from("motorist_profiles")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", profile.organization_id)
    .eq("role", "admin")
    .eq("active", true)
    .neq("access_status", "disabled")
    .neq("id", profile.id);

  if (error) {
    throw new MutationError("Admin ochranu sa nepodarilo overiť.", 500);
  }

  if (!count) {
    throw new MutationError("Nedá sa deaktivovať alebo zmeniť posledného admina.", 400);
  }
}

async function nextEmailIdempotencyKey(profileId: string, purpose: EmailPurpose) {
  const supabase = createSupabaseAdminClient();
  const { count } = await supabase
    .from("motorist_auth_email_events")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", profileId)
    .eq("purpose", purpose);

  return `access-${purpose}-${profileId}-${(count ?? 0) + 1}`;
}

async function recordEmailEvent(input: {
  organizationId: string;
  profileId?: string | null;
  purpose: EmailPurpose;
  recipientEmail: string;
  delivery: EmailDeliveryResult;
  idempotencyKey: string;
  requestedBy?: string | null;
  request?: Request;
}) {
  const supabase = createSupabaseAdminClient();
  const status = input.delivery.status === "sent" ? "sent" : input.delivery.status === "disabled" ? "skipped" : "failed";
  const requestIpValue = input.request ? requestIp(input.request) : null;
  const ipAddress = requestIpValue && requestIpValue !== "unknown" ? requestIpValue : null;

  await supabase.from("motorist_auth_email_events").insert({
    organization_id: input.organizationId,
    profile_id: input.profileId ?? null,
    purpose: input.purpose,
    recipient_email: input.recipientEmail,
    provider: input.delivery.provider,
    delivery_status: status,
    provider_message_id: input.delivery.status === "sent" ? input.delivery.messageId : null,
    idempotency_key: input.idempotencyKey,
    error_message: input.delivery.error,
    requested_by: input.requestedBy ?? null,
    request_ip: ipAddress,
    user_agent: input.request?.headers.get("user-agent") ?? null,
  });
}

function buildAccessEmail(input: { email: string; profile: ProfileRow; actionLink: string; purpose: "invite" | "reset_password"; idempotencyKey: string }) {
  const isReset = input.purpose === "reset_password";
  const title = isReset ? "Obnova hesla do dispečingu" : "Prístup do dispečingu";
  const button = isReset ? "Nastaviť nové heslo" : "Aktivovať prístup";
  const intro = isReset
    ? "Pre tvoj účet bol vyžiadaný reset hesla. Nové heslo si nastavíš cez bezpečný odkaz nižšie."
    : "Bol ti vytvorený prístup do dispečingu Pomoc Motoristom. Heslo si nastavíš cez bezpečný odkaz nižšie.";
  const detail = isReset
    ? "Odkaz je určený iba pre tvoj účet a platí obmedzený čas."
    : "Po aktivácii sa prihlásiš emailom a heslom. Admin alebo manažér ti vie prístup neskôr upraviť v nastaveniach používateľov.";
  const safeName = escapeHtml(input.profile.display_name);
  const safeTitle = escapeHtml(title);
  const safeIntro = escapeHtml(intro);
  const safeDetail = escapeHtml(detail);
  const safeActionLink = escapeHtml(input.actionLink);

  return {
    to: input.email,
    subject: isReset ? "Obnova hesla - Pomoc Motoristom" : "Prístup do dispečingu - Pomoc Motoristom",
    idempotencyKey: input.idempotencyKey,
    html: `
      <div style="margin:0;padding:0;background:#f4f4f5;color:#18181b;font-family:Inter,Arial,sans-serif;">
        <div style="padding:28px 16px;">
          <div style="max-width:600px;margin:0 auto;overflow:hidden;border:1px solid #e4e4e7;border-radius:12px;background:#ffffff;box-shadow:0 18px 45px rgba(24,24,27,.10);">
            <div style="height:8px;background:#FCD703;"></div>
            <div style="padding:28px;">
              <div style="display:flex;align-items:center;gap:12px;margin-bottom:26px;">
                <div style="width:44px;height:44px;border-radius:8px;background:#FCD703;color:#09090b;font-size:16px;font-weight:900;line-height:44px;text-align:center;">PM</div>
                <div>
                  <div style="font-size:11px;line-height:1.2;letter-spacing:.14em;text-transform:uppercase;color:#71717a;font-weight:800;">Pomoc Motoristom</div>
                  <div style="font-size:14px;line-height:1.35;color:#09090b;font-weight:800;margin-top:3px;">Dispečing</div>
                </div>
              </div>
              <h1 style="font-size:26px;line-height:1.2;margin:0 0 14px;color:#09090b;font-weight:800;">${safeTitle}</h1>
              <p style="font-size:15px;line-height:1.6;color:#3f3f46;margin:0 0 12px;">Ahoj ${safeName},</p>
              <p style="font-size:15px;line-height:1.65;color:#3f3f46;margin:0 0 16px;">${safeIntro}</p>
              <div style="border:1px solid #facc15;background:#fefce8;border-radius:8px;padding:12px 14px;margin:0 0 22px;">
                <p style="font-size:13px;line-height:1.55;color:#3f3f46;margin:0;">${safeDetail}</p>
              </div>
              <a href="${safeActionLink}" style="display:inline-block;background:#09090b;color:#ffffff;text-decoration:none;font-weight:800;border-radius:8px;padding:13px 18px;">${escapeHtml(button)}</a>
              <p style="font-size:12px;line-height:1.55;color:#71717a;margin:24px 0 0;">Ak tlačidlo nefunguje, otvor tento link:<br><a href="${safeActionLink}" style="color:#18181b;text-decoration:underline;">${safeActionLink}</a></p>
              <p style="font-size:12px;line-height:1.55;color:#71717a;margin:18px 0 0;">Ak si túto požiadavku nečakal/a, email ignoruj alebo kontaktuj správcu.</p>
            </div>
          </div>
          <p style="max-width:600px;margin:14px auto 0;text-align:center;font-size:11px;line-height:1.5;color:#71717a;">Pomoc Motoristom | interný prístup do dispečingu</p>
        </div>
      </div>
    `,
    text: `Pomoc Motoristom - dispečing\n\nAhoj ${input.profile.display_name},\n\n${intro}\n\n${detail}\n\n${button}: ${input.actionLink}\n\nAk si túto požiadavku nečakal/a, email ignoruj alebo kontaktuj správcu.`,
  };
}

function nextEnabledStatus(profile: ProfileRow): AccessStatus {
  if (!profile.user_id) {
    return "not_invited";
  }

  return profile.password_set_at ? "active" : "invited";
}

function normalizeEmail(value: unknown) {
  const email = cleanString(value).toLowerCase();
  return email || null;
}

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
