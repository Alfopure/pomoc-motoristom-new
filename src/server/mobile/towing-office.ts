import 'server-only';
import type { TowingCommand, TowingOrder, TowingWorkspace } from '@/domain/towing/types';
import { cashBreakdownTotal, isCashBreakdown, isCashCategory } from '@/domain/towing/cash-categories';
import { MutationError } from '@/server/mutation-error';
import { towingEnabled } from '@/server/towing/auth';
import { createTowingOrder, parseTowingCreateInput } from '@/server/towing/creation';
import { TowingError, uuid } from '@/server/towing/http';
import { executeTowingCommand, loadTowingWorkspace, parseTowingCommand, workspaceFilters } from '@/server/towing/service';
import type { MobileFieldActor } from './field-auth';
import { projectTowingOrder, towingMember, towingTime } from './field-work';

/** Stored work fields can contain PostgreSQL text timestamps. Native clients receive ISO only. */
function normalizeOfficeOrder(order: TowingOrder): TowingOrder {
  const fields = { ...order.fields };
  for (const key of ['plannedAt', 'startedAt', 'finishedAt', 'handedOverAt'] as const) {
    const value = towingTime(fields[key]);
    if (value) fields[key] = value;
    else delete fields[key];
  }
  return { ...order, fields };
}

function normalizeOfficeWorkspace(workspace: TowingWorkspace): TowingWorkspace {
  return { ...workspace, orders: workspace.orders.map(normalizeOfficeOrder) };
}

function requireOffice(actor: MobileFieldActor) {
  if (!actor.capabilities.includes('operate')) throw new MutationError('Nemáte prístup do odťahovej kancelárie.', 403, 'mobile_no_towing_office');
  if (!towingEnabled()) throw new MutationError('Odťahy ešte nie sú v tomto prostredí zapnuté.', 503, 'towing_unavailable');
}

/** The existing member works without a main dispatch profile. */
export async function loadMobileTowingOffice(actor: MobileFieldActor, url: URL) {
  requireOffice(actor);
  return normalizeOfficeWorkspace(await loadTowingWorkspace(towingMember(actor), 'office', workspaceFilters(url)));
}

export async function readMobileTowingOfficeOrder(actor: MobileFieldActor, id: string): Promise<TowingOrder> {
  requireOffice(actor);
  const target = uuid(id).toLowerCase();
  const order = (await loadTowingWorkspace(towingMember(actor), 'office', { orderId: target, limit: 1, offset: 0 })).orders.find(row => row.id === target);
  if (!order) throw new MutationError('Odťah sa nenašiel alebo k nemu nemáte prístup.', 404);
  return normalizeOfficeOrder(order);
}

export async function createMobileTowingOrder(actor: MobileFieldActor, value: unknown) {
  const input = parseTowingCreateInput(value);
  const receipt = await createTowingOrder(towingMember(actor), input);
  // Office authors do not acquire a driver's projection or implied own assignment.
  const row = input.mode === 'self'
    ? (await loadTowingWorkspace(towingMember(actor), 'driver', { orderId: receipt.targetId, limit: 1, offset: 0 })).orders.find(order => order.id === receipt.targetId)
    : undefined;
  return { ...receipt, order: row ? projectTowingOrder(row, actor.memberId) : null };
}

const operationalCommands = ['update_order', 'assign', 'start', 'submit', 'return', 'cancel'];
const cashCommands = ['accept_handover', 'reject_handover', 'cancel_handover', 'collect_cash'];
const exactPositive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const inputError = (message: string): never => { throw new TowingError('invalid_input', 400, message); };

function validateOfficeCashCommand(command: TowingCommand) {
  const payload = command.payload;
  const allowed = command.type === 'collect_cash' ? ['driverId', 'amountCents', 'accountRevision', 'officeRevision', 'cashBreakdown']
    : command.type === 'accept_handover' ? ['accountRevision', 'officeRevision'] : ['reason'];
  if (Object.keys(payload).some(key => !allowed.includes(key))) inputError('Odovzdanie hotovosti obsahuje nepovolené údaje.');
  if (command.type === 'accept_handover' || command.type === 'collect_cash') {
    if (!exactPositive(payload.accountRevision) || !exactPositive(payload.officeRevision)) inputError('Obnovte aktuálny stav pokladní.');
  } else if (typeof payload.reason !== 'string' || !payload.reason.trim() || payload.reason.length > 1000) inputError('Doplňte dôvod zmeny odovzdania hotovosti.');
  if (command.type === 'collect_cash') {
    uuid(payload.driverId, 'Vodič');
    if (!exactPositive(payload.amountCents)) inputError('Zadajte presnú prevzatú sumu.');
    if (payload.cashBreakdown !== undefined && (!isCashBreakdown(payload.cashBreakdown) || cashBreakdownTotal(payload.cashBreakdown) !== payload.amountCents))
      inputError('Rozpis hotovosti sa musí rovnať prevzatej sume.');
  }
}

async function validateOfficeReceipt(actor: MobileFieldActor, command: TowingCommand) {
  if (!actor.capabilities.includes('bill')) throw new MutationError('Nemáte oprávnenie zaznamenať prijatú platbu za vodiča.', 403);
  const payload = command.payload;
  if (Object.keys(payload).some(key => !['receiptId', 'amountCents', 'method', 'driverId', 'accountRevision', 'cashCategory'].includes(key))
    || !exactPositive(payload.amountCents) || !['cash', 'card'].includes(String(payload.method))) inputError('Skontrolujte údaje prijatej platby.');
  uuid(payload.receiptId, 'Potvrdenka');
  const order = await readMobileTowingOfficeOrder(actor, command.targetId);
  // The person entering an old receipt is its audit author, not its cash custodian.
  if (payload.driverId !== undefined && uuid(payload.driverId, 'Vodič').toLowerCase() !== order.driverId) inputError('Platbu priraďte vodičovi tejto zákazky.');
  if (payload.method === 'cash' && (payload.driverId === undefined || !order.driverId || !exactPositive(payload.accountRevision)))
    inputError('Pri hotovosti potvrďte vodiča, ktorý ju prevzal, a aktuálnu verziu jeho pokladne.');
  if (payload.cashCategory !== undefined && (payload.method !== 'cash' || !isCashCategory(payload.cashCategory))) inputError('Vyberte platnú kategóriu hotovosti.');
}

/** Office requests never sneak into the own-driver path through assignmentGeneration. */
export async function commandMobileTowingOffice(actor: MobileFieldActor, value: unknown) {
  requireOffice(actor);
  if (!value || typeof value !== 'object' || Array.isArray(value)) inputError('Neplatný kancelársky príkaz.');
  const input = value as Record<string, unknown>;
  if ('assignmentGeneration' in input) inputError('Kancelársky príkaz nepoužíva vodičovo pridelenie.');
  const command = parseTowingCommand(input);
  if (![...operationalCommands, ...cashCommands, 'receive_payment'].includes(command.type)) inputError('Táto operácia nie je v mobilnej kancelárii dostupná.');
  if (cashCommands.includes(command.type) && !actor.capabilities.includes(command.type === 'cancel_handover' ? 'correct' : 'cash'))
    throw new MutationError('Nemáte oprávnenie spravovať odovzdanie hotovosti.', 403);
  if (cashCommands.includes(command.type)) validateOfficeCashCommand(command);
  if (command.type === 'receive_payment') await validateOfficeReceipt(actor, command);
  const receipt = await executeTowingCommand(towingMember(actor), command);
  const order = cashCommands.includes(command.type) ? null
    : (await loadTowingWorkspace(towingMember(actor), 'office', { orderId: command.targetId, limit: 1, offset: 0 })).orders.find(row => row.id === command.targetId) ?? null;
  return { ...receipt, order: order ? normalizeOfficeOrder(order) : null, ...(cashCommands.includes(command.type)
    ? { workspace: normalizeOfficeWorkspace(await loadTowingWorkspace(towingMember(actor), 'office', { limit: 50, offset: 0 })) } : {}) };
}
