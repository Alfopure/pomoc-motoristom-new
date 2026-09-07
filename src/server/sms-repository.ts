import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";
import type { SmsHistoryEntry } from "@/lib/sms/contracts";
import { publicLocationLinkStatus } from "@/lib/sms/location-share";
import { getTelnyxConfig, TELNYX_DEFAULT_ALPHA_SENDER } from "@/server/telephony/telnyx/env";
import { normalizeSmsRecipient, SmsWorkflowError } from "./sms-workflow";

export async function loadSmsOptions(organizationId: string) {
  const admin = createSupabaseAdminClient();
  const [cases, contacts, profile] = await Promise.all([
    admin.from("motorist_cases").select("id, case_number, contact_id").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(1000),
    admin.from("motorist_contacts").select("id, name, phone").eq("organization_id", organizationId),
    admin.from("motorist_organization_profiles").select("primary_phone").eq("organization_id", organizationId).maybeSingle(),
  ]);
  if (cases.error || contacts.error || profile.error) throw new SmsWorkflowError("Prípady a kontakty sa nepodarilo načítať.");
  const contactsById = new Map((contacts.data ?? []).map((contact) => [contact.id, contact]));
  const config = getTelnyxConfig();
  return {
    cases: (cases.data ?? []).map((row) => {
      const contact = row.contact_id ? contactsById.get(row.contact_id) : null;
      let phone = contact?.phone ?? "";
      let validPhone = false;
      try { phone = normalizeSmsRecipient(phone); validPhone = true; } catch { /* Invalid contacts remain visible for repair. */ }
      return { id: row.id, caseNumber: row.case_number, name: contact?.name ?? "Bez kontaktu", phone, validPhone };
    }),
    callbackNumber: profile.data?.primary_phone ?? "",
    sender: config.configured ? config.smsAlphaSender : TELNYX_DEFAULT_ALPHA_SENDER,
    repliesEnabled: false,
  };
}

export async function loadSmsHistory(organizationId: string, caseId: string | null, offset = 0) {
  const admin = createSupabaseAdminClient();
  let query = admin.from("motorist_sms_messages").select("*").eq("organization_id", organizationId).eq("provider", "telnyx_sms");
  if (caseId) query = query.eq("case_id", caseId);
  const result = await query.order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 49);
  if (result.error) throw new SmsWorkflowError("Históriu SMS sa nepodarilo načítať.");
  const messages = result.data ?? [];
  if (!messages.length) return { messages: [], hasMore: false };
  const payloads = messages.map((row) => record(row.raw_payload));
  const caseIds = [...new Set(messages.flatMap((row) => row.case_id ? [row.case_id] : []))];
  const authorIds = [...new Set(payloads.flatMap((payload) => typeof payload.actor_profile_id === "string" ? [payload.actor_profile_id] : []))];
  const linkIds = payloads.flatMap((payload) => typeof payload.location_link_id === "string" ? [payload.location_link_id] : []);
  const [cases, authors, links, submissions] = await Promise.all([
    caseIds.length ? admin.from("motorist_cases").select("id, case_number").eq("organization_id", organizationId).in("id", caseIds) : null,
    authorIds.length ? admin.from("motorist_profiles").select("id, display_name").eq("organization_id", organizationId).in("id", authorIds) : null,
    linkIds.length ? admin.from("motorist_location_share_links").select("*").eq("organization_id", organizationId).in("id", linkIds) : null,
    linkIds.length ? admin.from("motorist_location_submissions").select("*").eq("organization_id", organizationId).in("link_id", linkIds).eq("accepted", true).order("submitted_at", { ascending: false }) : null,
  ]);
  if ([cases, authors, links, submissions].some((result) => result?.error)) throw new SmsWorkflowError("Podrobnosti histórie SMS sa nepodarilo načítať.");
  const entries: SmsHistoryEntry[] = messages.map((row, index) => {
    const payload = payloads[index];
    const link = links?.data?.find((link) => link.id === payload.location_link_id);
    const submission = link ? submissions?.data?.find((submission) => submission.link_id === link.id) : null;
    return {
      id: row.id, caseId: row.case_id, caseNumber: cases?.data?.find((item) => item.id === row.case_id)?.case_number ?? str(payload.case_number),
      recipientName: str(payload.recipient_name) ?? "Príjemca", toNumber: row.to_number,
      author: authors?.data?.find((author) => author.id === payload.actor_profile_id)?.display_name ?? "Autor nezaznamenaný",
      body: row.body, sender: row.from_sender || row.from_label || "Nezaznamenaný", createdAt: row.created_at,
      status: row.status, statusDetail: row.status_detail, error: row.error, template: row.template_key,
      location: link ? { status: publicLocationLinkStatus(link.status, link.expires_at), expiresAt: link.expires_at,
        ...(submission ? { submittedAt: submission.submitted_at, accuracy: submission.accuracy_meters, lat: submission.lat, lng: submission.lng } : {}) } : null,
    };
  });
  return { messages: entries, hasMore: messages.length === 50 };
}
function record(value: Json): Record<string, Json | undefined> { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function str(value: unknown) { return typeof value === "string" ? value : null; }
