import 'server-only';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OperationGrantCommand, OperationGrantContext, OperationGrantReceipt, PublicOperationCommand } from '@/domain/operation-grants';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { handoffOrigin, openHandoffToken, sealHandoffToken } from '@/server/handoff-secret';
import { MutationError } from '@/server/mutation-error';
import { assertRateLimit, requestIp } from '@/server/rate-limit';
import { assertTowingOrigin, boundedJson, mapRpcError, revision, TowingError, towingErrorResponse, uuid } from '@/server/towing/http';
import { requireOperationsActor } from './index';

const admin = () => createSupabaseAdminClient() as unknown as SupabaseClient;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const cookieName = 'pm_operation_grant';
const cookiePath = '/api/public/operation-handoffs';
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const headers = { 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', Vary: 'Cookie' };
export const operationGrantJson = (body: unknown, status = 200) => Response.json(body, { status, headers });
export function operationGrantError(error: unknown) {
  if (error instanceof MutationError || error instanceof TowingError) return operationGrantJson({ error: error.message }, error.status);
  const response = towingErrorResponse(error);
  return new Response(response.body, { status: response.status, headers });
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new TowingError('invalid_input', 400, 'Požiadavka obsahuje nepovolené údaje.');
}
export function parseGrantCommand(value: Record<string, unknown>): OperationGrantCommand {
  exactKeys(value, ['action', 'commandId', 'expectedRevision', 'previewVersion', 'hours', 'grantId', 'reason']);
  if (!['issue', 'revoke', 'recover'].includes(String(value.action))) throw new TowingError('invalid_input', 400, 'Neplatná akcia odkazu.');
  const command: OperationGrantCommand = { action: value.action as OperationGrantCommand['action'], commandId: uuid(value.commandId), expectedRevision: revision(value.expectedRevision) };
  if (command.action === 'issue') {
    if (typeof value.previewVersion !== 'string' || !/^[a-f0-9]{64}$/.test(value.previewVersion) || !Number.isInteger(value.hours) || Number(value.hours) < 1 || Number(value.hours) > 72) throw new TowingError('invalid_input', 400, 'Potvrďte aktuálny náhľad a platnosť 1 až 72 hodín.');
    command.previewVersion = value.previewVersion; command.hours = Number(value.hours);
  } else command.grantId = uuid(value.grantId);
  if (command.action === 'revoke') {
    if (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 1000) throw new TowingError('invalid_input', 400, 'Vyplňte dôvod zrušenia odkazu.');
    command.reason = value.reason.trim();
  }
  return command;
}
export function parsePublicOperationCommand(value: Record<string, unknown>): PublicOperationCommand {
  exactKeys(value, ['action', 'commandId', 'grantId', 'expectedRevision']);
  if (!['accept', 'start', 'arrive', 'collect', 'complete'].includes(String(value.action))) throw new TowingError('invalid_input', 400, 'Neplatný krok jazdy.');
  return { action: value.action as PublicOperationCommand['action'], commandId: uuid(value.commandId), grantId: uuid(value.grantId), expectedRevision: revision(value.expectedRevision) };
}
export async function getOperationGrantContext(operationId: string): Promise<OperationGrantContext> {
  const actor = await requireOperationsActor();
  const result = await admin().rpc('motorist_operation_grant', { p_user_id: actor.userId, p_organization_id: actor.organizationId, p_operation_id: uuid(operationId), p_action: 'context', p_input: {} });
  mapRpcError(result.error);
  return result.data as OperationGrantContext;
}
export async function commandOperationGrant(request: Request, operationId: string): Promise<OperationGrantReceipt> {
  assertTowingOrigin(request);
  const command = parseGrantCommand(await boundedJson(request, 8000));
  const actor = await requireOperationsActor();
  const operation = uuid(operationId);
  const scope = { p_user_id: actor.userId, p_organization_id: actor.organizationId, p_operation_id: operation };
  let secret: Record<string, unknown> = {};
  if (command.action === 'issue') {
    const token = randomBytes(32).toString('base64url'), grantId = randomUUID(), tokenHash = hash(token), origin = handoffOrigin(request);
    secret = { issuedId: grantId, tokenHash, linkOrigin: origin, tokenEnvelope: sealHandoffToken(token, { organizationId: actor.organizationId, caseId: operation, handoffId: grantId, generation: 1, tokenHash, origin }) };
  }
  const client = admin();
  const result = await client.rpc('motorist_operation_grant', { ...scope, p_action: command.action, p_input: { ...command, ...secret } });
  mapRpcError(result.error);
  const receipt = result.data as OperationGrantReceipt;
  if (receipt.commandId !== command.commandId || !receipt.grant?.id || !Number.isSafeInteger(receipt.committedRevision)) throw new TowingError('unconfirmed', 503, 'Výsledok sa nepodarilo overiť. Zopakujte tú istú požiadavku.');
  if (command.action === 'revoke') return receipt;
  const material = await client.rpc('motorist_operation_grant_secret', { ...scope, p_grant_id: receipt.grant.id });
  mapRpcError(material.error);
  const stored = material.data as { tokenHash: string; tokenEnvelope: unknown; origin: string };
  const token = openHandoffToken(stored.tokenEnvelope, { organizationId: actor.organizationId, caseId: operation, handoffId: receipt.grant.id, generation: 1, tokenHash: stored.tokenHash, origin: stored.origin });
  return { ...receipt, url: `${stored.origin}/jazda?grant=${encodeURIComponent(receipt.grant.id)}#token=${token}` };
}
export async function publicOperationGrant(request: Request, action: 'session' | 'read' | 'command') {
  if (action !== 'read') assertTowingOrigin(request);
  assertRateLimit(`operation-grant:${action}:${hash(requestIp(request))}`, { limit: action === 'read' ? 100 : 35, windowMs: 60_000 });
  const input = action === 'read' ? { grantId: uuid(new URL(request.url).searchParams.get('grant')) } : await boundedJson(request, 4000);
  if (action === 'session') exactKeys(input, ['token']);
  const jar = await cookies();
  const token = action === 'session' ? input.token : jar.get(cookieName)?.value;
  if (typeof token !== 'string' || !tokenPattern.test(token)) throw new TowingError('not_found', 404, 'Odkaz nie je dostupný. Vyžiadajte si aktuálny odkaz od kancelárie.');
  const session = randomBytes(32).toString('base64url');
  const payload = action === 'session' ? { sessionHash: hash(session) } : action === 'command' ? parsePublicOperationCommand(input) : input;
  const result = await admin().rpc('motorist_public_operation_grant', { p_action: action, p_token_hash: hash(token), p_input: payload });
  if (result.error?.code === '54000') throw new TowingError('rate_limit', 429, 'Príliš veľa otvorení odkazu. Skúste to neskôr.');
  mapRpcError(result.error);
  const body = result.data as { publication: unknown; commandId?: string; committedRevision?: number; sessionExpiresAt?: string };
  if (action === 'session') {
    if (!body.sessionExpiresAt || !Number.isFinite(Date.parse(body.sessionExpiresAt))) throw new TowingError('unavailable', 503, 'Overenie odkazu sa nepodarilo dokončiť.');
    jar.set(cookieName, session, { httpOnly: true, secure: true, sameSite: 'strict', path: cookiePath, expires: new Date(body.sessionExpiresAt) });
  }
  return { publication: body.publication, ...(body.commandId ? { commandId: body.commandId, committedRevision: body.committedRevision } : {}) };
}
