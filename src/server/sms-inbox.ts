import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { SmsActor, SmsConversationEntry, SmsInboxMessage } from "@/lib/sms/contracts";
import { canReplyToSms, getSmsChannel } from "./sms-channel";
import { normalizeSmsRecipient, SmsWorkflowError } from "./sms-errors";

type Admin = SupabaseClient<Database>;
type SmsRow = Database["public"]["Tables"]["motorist_sms_messages"]["Row"];
const PAGE_SIZE = 50;

export async function getInboundSms(admin: Admin, organizationId: string, id: string) {
  const result = await admin.from("motorist_sms_messages").select("*").eq("organization_id", organizationId)
    .eq("provider", "telnyx_sms").eq("direction", "inbound").eq("id", id).maybeSingle();
  if (result.error) throw new SmsWorkflowError("Prijatú SMS sa nepodarilo načítať.");
  if (!result.data) throw new SmsWorkflowError("Prijatá SMS sa nenašla.", 404);
  return result.data;
}

export async function loadSmsReplyContext(admin: Admin, organizationId: string, id: string) {
  const row = await getInboundSms(admin, organizationId, id);
  const toNumber = normalizeSmsRecipient(row.from_sender);
  if (!canReplyToSms(getSmsChannel(), organizationId, row.to_number, toNumber, row.messaging_profile_id)) {
    throw new SmsWorkflowError("Na túto SMS zatiaľ nemožno odpovedať z rovnakého overeného čísla.", 423);
  }
  const linkedCase = row.case_id ? await admin.from("motorist_cases").select("id, case_number")
    .eq("organization_id", organizationId).eq("id", row.case_id).maybeSingle() : null;
  if (linkedCase?.error || (row.case_id && !linkedCase?.data)) throw new SmsWorkflowError("Priradenie prípadu sa nepodarilo overiť.", 409);
  return { row, toNumber, caseNumber: linkedCase?.data?.case_number ?? null };
}

export async function loadSmsInboxSummary(organizationId: string) {
  const admin = createSupabaseAdminClient();
  const count = await admin.from("motorist_sms_messages").select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId).eq("provider", "telnyx_sms").eq("direction", "inbound").eq("status_detail", "received_unread");
  if (count.error) throw new SmsWorkflowError("Počet neprečítaných SMS sa nepodarilo načítať.");
  return { unreadCount: count.count ?? 0 };
}

export async function loadSmsInbox(organizationId: string, filter: "all" | "unread" | "unassigned" = "all", offset = 0) {
  const admin = createSupabaseAdminClient();
  let query = admin.from("motorist_sms_messages").select("*").eq("organization_id", organizationId)
    .eq("provider", "telnyx_sms").eq("direction", "inbound");
  if (filter === "unread") query = query.eq("status_detail", "received_unread");
  if (filter === "unassigned") query = query.is("case_id", null);
  const [result, summary, operators] = await Promise.all([
    query.order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + PAGE_SIZE),
    loadSmsInboxSummary(organizationId),
    admin.from("motorist_profiles").select("id, display_name").eq("organization_id", organizationId).eq("active", true).eq("access_status", "active"),
  ]);
  if (result.error || operators.error) throw new SmsWorkflowError("Prijaté SMS sa nepodarilo načítať.");
  return {
    messages: await inboxEntries(admin, organizationId, (result.data ?? []).slice(0, PAGE_SIZE)),
    hasMore: (result.data?.length ?? 0) > PAGE_SIZE, ...summary,
    operators: (operators.data ?? []).map((row) => ({ id: row.id, name: row.display_name })),
  };
}

export async function loadSmsConversation(organizationId: string, id: string, offset = 0) {
  const admin = createSupabaseAdminClient();
  const anchor = await getInboundSms(admin, organizationId, id);
  const remote = normalizeSmsRecipient(anchor.from_sender);
  const local = normalizeSmsRecipient(anchor.to_number);
  let query = admin.from("motorist_sms_messages").select("*").eq("organization_id", organizationId).eq("provider", "telnyx_sms")
    .in("from_sender", [remote, local]).in("to_number", [remote, local]);
  query = anchor.messaging_profile_id == null ? query.is("messaging_profile_id", null) : query.eq("messaging_profile_id", anchor.messaging_profile_id);
  const result = await query.order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + PAGE_SIZE);
  if (result.error) throw new SmsWorkflowError("Konverzáciu sa nepodarilo načítať.");
  // Direction and the exact two endpoints are checked even for old/imported rows.
  const rows = (result.data ?? []).slice(0, PAGE_SIZE).filter((row) => row.direction === "inbound"
    ? row.from_sender === remote && row.to_number === local : row.from_sender === local && row.to_number === remote);
  const caseIds = [...new Set(rows.flatMap((row) => row.case_id ? [row.case_id] : []))];
  const cases = caseIds.length ? await admin.from("motorist_cases").select("id, case_number").eq("organization_id", organizationId).in("id", caseIds) : null;
  if (cases?.error) throw new SmsWorkflowError("Prípady konverzácie sa nepodarilo načítať.");
  const messages: SmsConversationEntry[] = rows.reverse().map((row) => ({
    id: row.id, body: row.body, direction: row.direction, createdAt: row.created_at, status: row.status,
    statusDetail: row.status_detail, caseId: row.case_id,
    caseNumber: cases?.data?.find((item) => item.id === row.case_id)?.case_number ?? null,
  }));
  return { message: (await inboxEntries(admin, organizationId, [anchor]))[0], messages, hasMore: (result.data?.length ?? 0) > PAGE_SIZE };
}

export type SmsInboxUpdate = { read?: boolean; caseId?: string | null; assignedProfileId?: string | null; version?: string };
export async function updateSmsInboxMessage(actor: SmsActor, id: string, input: SmsInboxUpdate) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["read", "caseId", "assignedProfileId", "version"].includes(key))
    || (input.read !== undefined && typeof input.read !== "boolean")
    || [input.caseId, input.assignedProfileId, input.version].some((value) => value != null && typeof value !== "string")
    || (input.read === undefined && input.caseId === undefined && input.assignedProfileId === undefined)) {
    throw new SmsWorkflowError("Neplatná úprava prijatej SMS.", 400);
  }
  const assigns = input.caseId !== undefined || input.assignedProfileId !== undefined;
  if (assigns && !input.version) throw new SmsWorkflowError("Najprv obnovte prijatú SMS.", 409);
  const admin = createSupabaseAdminClient();
  if (input.caseId) {
    const target = await admin.from("motorist_cases").select("id").eq("organization_id", actor.organizationId).eq("id", input.caseId).maybeSingle();
    if (target.error || !target.data) throw new SmsWorkflowError("Prípad sa nenašiel v tejto organizácii.", 400);
  }
  if (input.assignedProfileId) {
    const target = await admin.from("motorist_profiles").select("id").eq("organization_id", actor.organizationId).eq("id", input.assignedProfileId)
      .eq("active", true).eq("access_status", "active").maybeSingle();
    if (target.error || !target.data) throw new SmsWorkflowError("Dispečer nie je aktívnym členom tejto organizácie.", 400);
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await getInboundSms(admin, actor.organizationId, id);
    if (assigns && row.updated_at !== input.version) throw new SmsWorkflowError("SMS medzičasom upravil kolega. Obnovte konverzáciu.", 409);
    const payload = record(row.raw_payload);
    const inbox = { ...record(payload.inbox) };
    const now = new Date().toISOString();
    if (input.read !== undefined) { inbox.read_at = input.read ? now : null; inbox.read_by = actor.actorProfileId; }
    if (assigns) { inbox.assigned_by = actor.actorProfileId; inbox.assigned_at = now; }
    if (input.assignedProfileId !== undefined) inbox.assigned_profile_id = input.assignedProfileId || null;
    const values: Database["public"]["Tables"]["motorist_sms_messages"]["Update"] = { raw_payload: { ...payload, inbox } };
    if (input.caseId !== undefined) values.case_id = input.caseId || null;
    if (input.read !== undefined) values.status_detail = input.read ? "received_read" : "received_unread";
    const updated = await admin.from("motorist_sms_messages").update(values).eq("organization_id", actor.organizationId)
      .eq("id", id).eq("direction", "inbound").eq("updated_at", row.updated_at).select("id").maybeSingle();
    if (updated.error) throw new SmsWorkflowError("Úpravu prijatej SMS sa nepodarilo uložiť.");
    if (updated.data) return { smsMessageId: id };
  }
  throw new SmsWorkflowError("SMS sa práve mení. Obnovte konverzáciu.", 409);
}

async function inboxEntries(admin: Admin, organizationId: string, rows: SmsRow[]): Promise<SmsInboxMessage[]> {
  const caseIds = [...new Set(rows.flatMap((row) => row.case_id ? [row.case_id] : []))];
  const profileIds = [...new Set(rows.flatMap((row) => {
    const id = record(record(row.raw_payload).inbox).assigned_profile_id;
    return typeof id === "string" ? [id] : [];
  }))];
  const [cases, profiles] = await Promise.all([
    caseIds.length ? admin.from("motorist_cases").select("id, case_number").eq("organization_id", organizationId).in("id", caseIds) : null,
    profileIds.length ? admin.from("motorist_profiles").select("id, display_name").eq("organization_id", organizationId).in("id", profileIds) : null,
  ]);
  if (cases?.error || profiles?.error) throw new SmsWorkflowError("Priradenie prijatej SMS sa nepodarilo načítať.");
  const channel = getSmsChannel();
  return rows.map((row) => {
    const payload = record(row.raw_payload);
    const assignedId = record(payload.inbox).assigned_profile_id;
    const media = record(record(payload.provider_event).payload).media;
    return {
      id: row.id, from: row.from_sender ?? row.from_label ?? "Neznámy odosielateľ", to: row.to_number,
      body: row.body, createdAt: row.created_at, version: row.updated_at,
      unread: row.status_detail === "received_unread", caseId: row.case_id,
      caseNumber: cases?.data?.find((item) => item.id === row.case_id)?.case_number ?? null,
      assignedProfileId: typeof assignedId === "string" ? assignedId : null,
      assignedName: profiles?.data?.find((item) => item.id === assignedId)?.display_name ?? null,
      canReply: canReplyToSms(channel, organizationId, row.to_number, row.from_sender ?? "", row.messaging_profile_id),
      hasMedia: Array.isArray(media) && media.length > 0,
    };
  });
}
function record(value: Json | undefined): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
