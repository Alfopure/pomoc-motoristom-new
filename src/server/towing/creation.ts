import 'server-only';
import { towingCreateFieldNames, type TowingCreateInput } from '@/domain/towing/creation';
import type { TowingCommandResult, TowingFields, TowingMember, TowingParty, TowingRealizedItem } from '@/domain/towing/types';
import { towingAssignmentProblems, towingCompletionProblems } from '@/domain/towing/validation';
import { isHistoryTimestamp } from '@/lib/telephony/call-history-query';
import { queueWorkPush } from '@/server/mobile/push-outbox';
import { actorRpcParams, assertTowingEnabled } from './auth';
import { towingAdmin } from './client';
import { mapRpcError, TowingError, uuid } from './http';

const fail = (message: string): never => { throw new TowingError('invalid_input', 400, message); };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : fail('Neplatné údaje nového odťahu.');
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('Nový odťah obsahuje nepovolené údaje.');
}
function text(value: unknown, max = 4000): string {
  if (typeof value !== 'string' || value.length > max) fail('Skontrolujte textové údaje odťahu.');
  return (value as string).trim();
}
const partyKeys = ['name', 'phone', 'email', 'address', 'companyId', 'taxId'];
function party(value: unknown): TowingParty {
  const input = record(value); keys(input, partyKeys);
  const result: Record<string, string> = { name: text(input.name, 2000) };
  for (const key of partyKeys.slice(1)) if (input[key] !== undefined && input[key] !== null) result[key] = text(input[key], 2000);
  return result as unknown as TowingParty;
}
function realizedItems(value: unknown): TowingRealizedItem[] {
  if (!Array.isArray(value) || value.length > 50) fail('Odťah môže obsahovať najviac 50 úkonov.');
  const ids = new Set<string>();
  return (value as unknown[]).map(raw => {
    const item = record(raw); keys(item, ['id', 'kind', 'description', 'quantity', 'unit', 'parkingId', 'destination']);
    const id = uuid(item.id).toLowerCase();
    if (ids.has(id)) fail('Každý úkon musí mať vlastný identifikátor.');
    ids.add(id);
    if (!['tow', 'repair', 'transport', 'storage', 'relocation'].includes(String(item.kind))) fail('Vyberte platný druh úkonu.');
    const quantity = text(item.quantity, 40);
    if (quantity && !/^[0-9]{1,9}(\.[0-9]{1,3})?$/.test(quantity)) fail('Skontrolujte množstvo úkonu.');
    return { id, kind: item.kind as TowingRealizedItem['kind'], description: text(item.description, 2000), quantity, unit: text(item.unit, 40),
      ...(item.parkingId ? { parkingId: uuid(item.parkingId).toLowerCase() } : {}),
      ...(item.destination !== undefined && item.destination !== null ? { destination: text(item.destination, 2000) } : {}) };
  });
}

/** Kept separate from ordinary commands: drive never acquires office operate rights. */
export function parseTowingCreateInput(value: unknown): TowingCreateInput {
  const body = record(value); keys(body, ['commandId', 'targetId', 'mode', 'fields', 'driverId', 'completed', 'officeNotes']);
  if (body.mode !== 'self' && body.mode !== 'office') fail('Vyberte spôsob vytvorenia odťahu.');
  if (body.mode === 'self' && ['driverId', 'completed', 'officeNotes'].some(key => key in body)) fail('Vlastný odťah môžete vytvoriť iba pre seba.');
  if (body.completed !== undefined && typeof body.completed !== 'boolean') fail('Neplatný stav vykonaného odťahu.');
  const input = record(body.fields); keys(input, towingCreateFieldNames);
  if (!['tow', 'repair', 'transport', 'storage', 'relocation'].includes(String(input.serviceType))
    || !['vehicle', 'machine', 'material'].includes(String(input.subjectType))) fail('Vyberte druh služby a predmet odťahu.');
  const fields: Record<string, unknown> = {
    serviceType: input.serviceType, subjectType: input.subjectType,
    subjectDescription: text(input.subjectDescription), pickup: text(input.pickup),
  };
  for (const key of towingCreateFieldNames) {
    if (!(key in input) || ['serviceType', 'subjectType', 'subjectDescription', 'pickup'].includes(key)) continue;
    const value = input[key];
    if (value === null || value === undefined || value === '') continue;
    if (['requester', 'owner', 'customer', 'recipient'].includes(key)) fields[key] = party(value);
    else if (key === 'realizedItems') fields[key] = realizedItems(value);
    else if (['branchId', 'fleetAssetId', 'requesterId', 'assistancePartnerId', 'parkingId'].includes(key)) fields[key] = uuid(value).toLowerCase();
    else if (['plannedAt', 'startedAt', 'finishedAt', 'handedOverAt'].includes(key)) {
      if (!isHistoryTimestamp(value) || key !== 'plannedAt' && Date.parse(value as string) > Date.now() + 5 * 60_000) fail('Zadajte platný skutočný dátum a čas.');
      fields[key] = value;
    } else fields[key] = text(value, key === 'handoverRecipientName' ? 300 : key === 'handoverException' ? 2000 : 4000);
  }
  if (fields.requesterType !== undefined && !['assistance', 'selfpayer'].includes(String(fields.requesterType))) fail('Vyberte typ objednávateľa.');
  if (fields.paymentIntent !== undefined && !['partner_invoice', 'deferred_invoice', 'card_terminal', 'cash_terminal', 'cash_other'].includes(String(fields.paymentIntent))) fail('Vyberte dohodnutú úhradu.');
  if (fields.odometer && !/^[0-9]{1,9}(\.[0-9]{1,3})?$/.test(String(fields.odometer))) fail('Skontrolujte stav tachometra.');
  if (fields.startedAt && fields.finishedAt && Date.parse(String(fields.finishedAt)) < Date.parse(String(fields.startedAt))) fail('Koniec práce nemôže byť pred jej začiatkom.');
  const command: TowingCreateInput = {
    commandId: uuid(body.commandId).toLowerCase(), targetId: uuid(body.targetId).toLowerCase(), mode: body.mode as TowingCreateInput['mode'], fields: fields as unknown as TowingFields,
    ...(body.driverId !== undefined ? { driverId: uuid(body.driverId).toLowerCase() } : {}),
    ...(body.completed !== undefined ? { completed: body.completed as boolean } : {}),
    ...(body.officeNotes !== undefined ? { officeNotes: text(body.officeNotes, 10_000) } : {}),
  };
  if (command.completed && !command.driverId) fail('Pri vykonanom odťahu vyberte vodiča.');
  if (command.completed) {
    const problems = towingCompletionProblems({ fields: command.fields, attachments: [] });
    if (problems.length) fail(problems.join(' '));
  }
  return command;
}

export async function createTowingOrder(actor: TowingMember, value: unknown): Promise<TowingCommandResult> {
  assertTowingEnabled();
  const command = parseTowingCreateInput(value);
  const capability = command.mode === 'self' ? 'drive' : 'operate';
  if (!actor.active || !actor.capabilities.includes(capability)) throw new TowingError('access_denied', 403, 'Na vytvorenie tohto odťahu nemáte oprávnenie.');
  if (command.mode === 'self' || command.driverId) {
    const problems = towingAssignmentProblems(command.fields, command.mode === 'self' ? actor.id : command.driverId!);
    if (problems.length) fail(problems.join(' '));
  }
  const { data, error } = await towingAdmin().rpc('motorist_towing_create', { ...actorRpcParams(actor), p_input: command });
  mapRpcError(error);
  const result = data as TowingCommandResult | null;
  if (!result || result.commandId !== command.commandId || result.targetId !== command.targetId || !Number.isSafeInteger(result.revision) || result.revision < 1)
    throw new TowingError('unavailable', 503, 'Vytvorenie odťahu sa nepodarilo potvrdiť. Overte pôvodné zadanie.');
  // Historical evidence creates no fresh work alert. Self-assignment does not ring the author.
  if (command.mode === 'office' && command.driverId && !command.completed) queueWorkPush(actor.organizationId);
  return result;
}
