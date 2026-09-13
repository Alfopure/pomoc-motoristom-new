import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";
import { isHandoffReceipt, type HandoffCommand, type HandoffContext, type HandoffReceipt } from "@/domain/case-handoff";
import { requireDefaultMotoristActor } from "./api-auth";
import { MutationError } from "./mutation-error";
import { assertRateLimit, requestIp } from "./rate-limit";

export const HANDOFF_COOKIE = "pm_handoff_session";
export const HANDOFF_HEADERS = { "Cache-Control": "private, no-store, max-age=0", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Frame-Options": "DENY" };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export const handoffHash = (value: string) => createHash("sha256").update(value).digest("hex");
export function handoffResponse(body: unknown, status = 200) { return Response.json(body, { status, headers: HANDOFF_HEADERS }); }
export function handoffError(error: unknown) { return handoffResponse({ error: error instanceof MutationError ? error.message : "Odovzdanie sa nepodarilo overiť. Skúste to znova." }, error instanceof MutationError ? error.status : 503); }
function id(value: unknown) { if (typeof value !== "string" || !uuid.test(value)) throw new MutationError("Neplatná referencia požiadavky.", 400); return value; }
function rpcError(error: { code?: string }): never {
  const code = error.code ?? "";
  if (["PGRST202", "42883", "42P01"].includes(code)) throw new MutationError("Externé odovzdanie ešte nie je aktivované v databáze tejto aplikácie.", 503);
  if (code === "42501") throw new MutationError("Na toto odovzdanie nemáte oprávnenie.", 403);
  if (code === "P0002") throw new MutationError("Odkaz alebo prípad nie je dostupný. Vyžiadajte si aktuálny odkaz od dispečera.", 404);
  if (["PT409", "23505", "40001"].includes(code)) throw new MutationError("Údaje alebo stav sa zmenili. Načítajte aktuálnu kartu a rozhodnite sa znova.", 409);
  if (["22023", "22P02", "23514", "22007", "22008"].includes(code)) throw new MutationError("Skontrolujte príjemcu, pokyny, termín a dôvod zmeny.", 400);
  if (code === "54000") throw new MutationError("Príliš veľa otvorení odkazu. Skúste to neskôr.", 429);
  throw new MutationError("Výsledok sa nepodarilo overiť. Zopakujte tú istú požiadavku.", 503);
}
export async function readHandoffBody(request: Request) {
  // Strict origin is deliberate here: external cookies never bypass CSRF via an absent header.
  if (request.headers.get("origin") !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") throw new MutationError("Požiadavka neprešla bezpečnostnou kontrolou.", 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new MutationError("Požiadavka musí byť JSON.", 415);
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > 16_000) throw new MutationError("Požiadavka je príliš veľká.", 413);
  const reader = request.body?.getReader(); const parts: Uint8Array[] = []; let size = 0;
  if (!reader) throw new MutationError("Chýba požiadavka.", 400);
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 16_000) { await reader.cancel(); throw new MutationError("Požiadavka je príliš veľká.", 413); } parts.push(value); }
  let body: unknown; try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new MutationError("Neplatná požiadavka.", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new MutationError("Neplatná požiadavka.", 400);
  return body as Record<string, unknown>;
}
export function validateHandoffCommand(input: Record<string, unknown>, external = false): HandoffCommand {
  const actions = external ? ["accept", "reject", "en_route", "arrived", "complete", "update", "blocked"] : ["issue", "publish", "renew", "revoke"];
  if (typeof input.action !== "string" || !actions.includes(input.action)) throw new MutationError("Neplatná akcia odovzdania.", 400);
  const command: HandoffCommand = { action: input.action, commandId: id(input.commandId) };
  if (input.action !== "issue") {
    if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1 || Number(input.expectedRevision) > 2_147_483_647) throw new MutationError("Chýba aktuálna verzia karty.", 400);
    command.expectedRevision = Number(input.expectedRevision);
    if (!external) command.handoffId = id(input.handoffId);
  }
  if (external) {
    command.handoffId = id(input.handoffId);
    if (!Number.isSafeInteger(input.publishedVersion) || Number(input.publishedVersion) < 1) throw new MutationError("Chýba verzia zdieľaných údajov.", 400);
    command.publishedVersion = Number(input.publishedVersion);
  }
  for (const [key, limit] of Object.entries({ comment: 1000, instructions: 2000, recipientName: 160, recipientPhone: 30, previewVersion: 64 })) {
    if (input[key] !== undefined) { if (typeof input[key] !== "string" || input[key].length > limit) throw new MutationError("Text je príliš dlhý alebo neplatný.", 400); command[key] = input[key].trim(); }
  }
  if (["reject", "blocked", "revoke"].includes(command.action) && !command.comment) throw new MutationError("Napíšte dôvod.", 400);
  if (!external && ["issue", "publish"].includes(command.action) && !/^[a-f0-9]{64}$/.test(String(command.previewVersion))) throw new MutationError("Najprv načítajte náhľad zdieľaných údajov.", 400);
  if (command.action === "issue" && (!command.recipientName || !/^\+?[0-9 ()-]{5,30}$/.test(String(command.recipientPhone)))) throw new MutationError("Vyplňte stredisko alebo kolegu a jeho telefón.", 400);
  if (!external && ["issue", "renew"].includes(command.action)) { const hours = input.hours ?? 24; if (!Number.isInteger(hours) || Number(hours) < 1 || Number(hours) > 72) throw new MutationError("Platnosť môže byť 1 až 72 hodín.", 400); command.hours = hours; }
  for (const key of external ? ["eta"] : ["scheduledAt"]) {
    if (input[key] !== undefined) { if (input[key] === null || input[key] === "") command[key] = null; else if (typeof input[key] === "string" && Number.isFinite(Date.parse(input[key]))) command[key] = new Date(input[key]).toISOString(); else throw new MutationError("Neplatný termín.", 400); }
  }
  return command;
}
export async function getCaseHandoffContext(caseId: string): Promise<HandoffContext> {
  const actor = await requireDefaultMotoristActor(["dispatcher", "senior_dispatcher", "manager", "admin"]);
  const client = await createSupabaseServerClient();
  const { data, error } = await client.rpc("motorist_case_handoff", { p_organization_id: actor.organizationId, p_actor_id: actor.profileId, p_case_id: id(caseId), p_action: "context", p_input: {} });
  if (error) rpcError(error); return data as unknown as HandoffContext;
}
export async function commandCaseHandoff(request: Request, caseId: string): Promise<HandoffReceipt> {
  const input = await readHandoffBody(request);
  const actor = await requireDefaultMotoristActor(["dispatcher", "senior_dispatcher", "manager", "admin"]);
  const command = validateHandoffCommand(input), token = randomBytes(32).toString("base64url");
  const client = await createSupabaseServerClient();
  const { data, error } = await client.rpc("motorist_case_handoff", { p_organization_id: actor.organizationId, p_actor_id: actor.profileId, p_case_id: id(caseId), p_action: command.action,
    p_input: { ...command, ...(["issue", "renew"].includes(command.action) ? { tokenHash: handoffHash(token) } : {}) } as Json });
  if (error) rpcError(error);
  const receipt = data as unknown as HandoffReceipt;
  if (!isHandoffReceipt(receipt, command)) throw new MutationError("Potvrdenie sa nepodarilo overiť. Zopakujte tú istú požiadavku.", 503);
  return { ...receipt, ...(receipt.tokenAccepted ? { url: `${new URL(request.url).origin}/handoff#token=${token}` } : {}) };
}
export async function publicHandoff(request: Request, action: "session" | "read" | "command") {
  const input = action === "read" ? { handoffId: id(new URL(request.url).searchParams.get("handoff")) } : await readHandoffBody(request);
  assertRateLimit(`handoff:${action}:${handoffHash(requestIp(request))}`, { limit: action === "read" ? 120 : 40, windowMs: 60_000 });
  const jar = await cookies();
  const token = action === "session" ? input.token : jar.get(HANDOFF_COOKIE)?.value;
  if (typeof token !== "string" || !tokenPattern.test(token)) throw new MutationError("Odkaz nie je dostupný. Vyžiadajte si aktuálny odkaz od dispečera.", 404);
  const session = randomBytes(32).toString("base64url");
  const command = action === "command" ? validateHandoffCommand(input, true) : null;
  const client = createSupabaseAdminClient();
  const { data, error } = await client.rpc("motorist_public_handoff", { p_action: action, p_token_hash: handoffHash(token), p_input: (action === "session" ? { sessionHash: handoffHash(session) } : command ? { ...command } : input) as Json });
  if (error) rpcError(error);
  const receipt = data as unknown as HandoffReceipt & { sessionExpiresAt?: string };
  if (command && !isHandoffReceipt(receipt, command)) throw new MutationError("Potvrdenie sa nepodarilo overiť. Zopakujte tú istú požiadavku.", 503);
  if (action === "session") jar.set(HANDOFF_COOKIE, session, { httpOnly: true, secure: true, sameSite: "strict", path: "/api/public/handoffs", expires: new Date(receipt.sessionExpiresAt!) });
  return { handoff: receipt.handoff, ...(receipt.commandId ? { commandId: receipt.commandId, committedRevision: receipt.committedRevision } : {}) };
}
