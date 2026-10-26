import 'server-only';
import { TOWING_COMMANDS, type TowingCommand, type TowingCommandResult, type TowingMember, type TowingOrder, type TowingWorkspace } from '@/domain/towing/types';
import { actorRpcParams } from './auth';
import { towingAdmin } from './client';
import { mapRpcError, revision, TowingError, uuid } from './http';

export const internalCommands = new Set(['attachment_intent', 'attachment_finalize', 'issue_document', 'document_result', 'email_intent', 'email_result', 'set_member']);
export function parseTowingCommand(value: Record<string, unknown>, internal = false): TowingCommand {
  if (Object.keys(value).some(key => !['commandId','type','targetId','expectedRevision','assignmentGeneration','payload'].includes(key)))
    throw new TowingError('invalid_input', 400, 'Nepovolené údaje príkazu.');
  if (typeof value.type !== 'string' || !(TOWING_COMMANDS as readonly string[]).includes(value.type) || (!internal && internalCommands.has(value.type)))
    throw new TowingError('invalid_input', 400, 'Nepovolená operácia.');
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) throw new TowingError('invalid_input', 400, 'Chýbajú údaje príkazu.');
  const payload = value.payload as Record<string, unknown>;
  // Actor and organization always come from the verified session, never a client envelope.
  if (['organizationId','organization_id','actorId','actor_id','userId','user_id'].some(key => key in payload) && value.type !== 'set_member')
    throw new TowingError('invalid_input', 400, 'Nepovolená identita príkazu.');
  return { commandId: uuid(value.commandId), targetId: uuid(value.targetId), type: value.type as TowingCommand['type'], payload,
    ...(value.expectedRevision !== undefined ? { expectedRevision: revision(value.expectedRevision) } : {}),
    ...(value.assignmentGeneration !== undefined ? { assignmentGeneration: revision(value.assignmentGeneration) } : {}) };
}
export async function executeTowingCommand(actor: TowingMember, command: TowingCommand): Promise<TowingCommandResult> {
  const result = await towingAdmin().rpc('motorist_towing_command', { ...actorRpcParams(actor), p_command: command });
  mapRpcError(result.error);
  if (!result.data || typeof result.data !== 'object') throw new TowingError('unavailable', 503, 'Uloženie sa nepodarilo potvrdiť.');
  return result.data as TowingCommandResult;
}
export function workspaceFilters(url: URL) {
  const filters: Record<string, unknown> = {};
  for (const key of ['orderId','sourceCaseId','branchId','driverId','fleetAssetId']) { const value = url.searchParams.get(key); if (value) filters[key] = uuid(value); }
  for (const key of ['query','search','workStatus','billingStatus','paymentStatus','dateFrom','dateTo','vehicle','requester']) {
    const value = url.searchParams.get(key); if (value) { if (value.length > 200) throw new TowingError('invalid_input',400,'Filter je príliš dlhý.'); filters[key] = value; }
  }
  for (const [alias, key] of [['status','workStatus'],['from','dateFrom'],['to','dateTo']] as const) { const value = url.searchParams.get(alias); if (value && !filters[key]) { if (value.length > 200) throw new TowingError('invalid_input',400,'Neplatný filter.'); filters[key] = value; } }
  for (const [key, fallback, max] of [['limit', 50, 50], ['offset', 0, 100000]] as const) {
    const raw = url.searchParams.get(key); const value = raw === null ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < (key === 'limit' ? 1 : 0) || value > max) throw new TowingError('invalid_input',400,'Neplatné stránkovanie.'); filters[key] = value;
  }
  return filters;
}
export async function loadTowingWorkspace(actor: TowingMember, view: 'office' | 'driver', filters: Record<string, unknown> = {}): Promise<TowingWorkspace> {
  if (view === 'driver' ? !actor.capabilities.includes('drive') : !actor.capabilities.some(c => c !== 'drive')) throw new TowingError('access_denied',403,'Nemáte prístup k tomuto rozhraniu.');
  const result = await towingAdmin().rpc('motorist_towing_workspace', { ...actorRpcParams(actor), p_view: view, p_filters: filters });
  mapRpcError(result.error);
  const data = result.data as TowingWorkspace | null;
  if (!data || data.view !== view || !Array.isArray(data.orders)) throw new TowingError('unavailable',503,'Údaje zákaziek nie sú dostupné.');
  // Defense in depth: the driver projection must never contain office fields even for a dual-role actor.
  if (view === 'driver') {
    data.orders = data.orders.map(order => projectTowingDriverOrder(order,actor));
    data.members = []; data.taxRates = []; data.taxDate = null; data.taxConfigured = false;
  } else if (data.orders.length) {
    // The original RPC omits this persisted pricing date. Read only the rows it
    // authorized, and require the same revision so concurrent pricing cannot
    // combine an older set of lines with a newer date.
    const dates = await towingAdmin().from('motorist_towing_orders')
      .select('id,revision,tax_date').eq('organization_id', actor.organizationId)
      .in('id', data.orders.map(order => order.id));
    mapRpcError(dates.error);
    if (!Array.isArray(dates.data)) throw new TowingError('unavailable',503,'Dátumy nacenenia nie sú dostupné.');
    const byId = new Map(dates.data.map(row => [row.id, row]));
    data.orders = data.orders.map(order => {
      const row = byId.get(order.id);
      if (!row || row.revision !== order.revision) throw new TowingError('revision_conflict',409,'Zákazka sa počas načítania zmenila. Obnovte zoznam.');
      if (row.tax_date !== null && (typeof row.tax_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.tax_date)))
        throw new TowingError('unavailable',503,'Dátum nacenenia nie je dostupný.');
      return { ...order, taxDate: row.tax_date };
    });
  }
  return data;
}

export function projectTowingDriverOrder(order: TowingOrder, actor: TowingMember): TowingOrder {
  const fields = { serviceType: order.fields.serviceType, subjectType: order.fields.subjectType,
    subjectDescription: order.fields.subjectDescription, pickup: order.fields.pickup };
  for (const key of ['plate','vin','destination','contact','noContactReason','branchId','fleetAssetId','plannedAt','startedAt','finishedAt','startSource','driverNotes','performedQuantity','photoException','assistanceReference','parkingId','parkingName','parkingAddress','assistancePartnerName'] as const) {
    if (order.fields[key] !== undefined) Object.assign(fields, { [key]: order.fields[key] });
  }
  for (const key of ['requester', 'customer', 'owner', 'recipient'] as const) {
    const party = order.fields[key];
    if (party) Object.assign(fields, { [key]: { name: party.name, ...(party.phone ? { phone: party.phone } : {}) } });
  }
  return { id: order.id, number: order.number, sourceCaseId: null, revision: order.revision,
      assignmentGeneration: order.assignmentGeneration, driverId: order.driverId, workStatus: order.workStatus,
      billingStatus: order.billingStatus, paymentStatus: order.paymentStatus, fields,
      authorizedCollectionCents: order.authorizedCollectionCents, receivedCents: order.receivedCents, dueCents: order.dueCents,
      reconciliationRequired: order.reconciliationRequired, createdAt: order.createdAt, updatedAt: order.updatedAt, attachments: order.attachments,
      payments: order.payments?.filter(payment => payment.driverId === actor.id).map(payment => ({id:payment.id,receiptId:payment.receiptId,amountCents:payment.amountCents,method:payment.method,driverId:payment.driverId,createdAt:payment.createdAt})) };

}
