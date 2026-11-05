import type { TowingCapability, TowingFields, TowingOrder, TowingRole, TowingWorkStatus } from './types';
export const towingRoleCapabilities: Record<TowingRole, readonly TowingCapability[]> = {
  driver: ['drive'], dispatch: ['operate', 'price', 'documents'],
  billing: ['price', 'bill', 'cash', 'documents', 'report'],
  manager: ['operate', 'price', 'bill', 'cash', 'correct', 'members', 'documents', 'report'],
  delivery: ['deliver'],
  // Branch leads get no towing capability; their scope comes from work-group seats.
  branch: [],
};
export function capabilitiesForTowingRoles(roles: TowingRole[]): TowingCapability[] {
  return [...new Set(roles.flatMap(role => towingRoleCapabilities[role]))];
}
export const towingDriverFieldNames = ['startedAt', 'finishedAt', 'driverNotes', 'performedQuantity', 'photoException', 'destination', 'subjectDescription', 'plate', 'vin', 'odometer', 'realizedItems', 'paymentIntent', 'handoverRecipientName', 'handedOverAt', 'handoverException', 'owner'] as const;
export function driverTowingFields(fields: TowingFields): Partial<TowingFields> {
  const result = Object.fromEntries(towingDriverFieldNames.filter(key => fields[key] !== undefined).map(key => [key, fields[key]]));
  if (fields.owner) {
    const { name, phone, address, companyId } = fields.owner;
    result.owner = { name, ...(phone !== undefined ? { phone } : {}), ...(address !== undefined ? { address } : {}), ...(companyId !== undefined ? { companyId } : {}) };
  }
  return result;
}
export function towingAssignmentProblems(fields: TowingFields, driverId: string | null): string[] {
  const errors: string[] = [];
  errors.push(...realizedItemProblems(fields, false));
  if (fields.serviceType === 'storage' && !fields.parkingId) errors.push('Vyberte parkovisko uloženia.');
  if (!driverId) errors.push('Vyberte aktívneho vodiča.');
  if (!fields.branchId) errors.push('Vyberte pobočku.');
  if (!fields.pickup.trim()) errors.push('Vyplňte miesto nakládky.');
  if (!fields.contact?.trim() && !fields.noContactReason?.trim()) errors.push('Vyplňte kontakt alebo dôvod jeho absencie.');
  return errors;
}
export function towingCompletionProblems(order: Pick<TowingOrder, 'fields' | 'attachments'>, pendingReceiptIds: readonly string[] = []): string[] {
  const { fields, attachments } = order;
  const errors: string[] = [];
  errors.push(...realizedItemProblems(fields, true));
  if ((fields.handoverRecipientName?.trim() || fields.handedOverAt) && (!fields.handoverRecipientName?.trim() || !fields.handedOverAt) && !fields.handoverException?.trim()) errors.push('Doplňte príjemcu aj čas odovzdania alebo vysvetlite výnimku.');
  if (!fields.subjectDescription.trim()) errors.push('Doplňte predmet výkonu.');
  const start = Date.parse(fields.startedAt ?? ''); const end = Date.parse(fields.finishedAt ?? '');
  if (fields.startSource === 'assignment') errors.push('Potvrďte skutočný začiatok výkonu; čas pridelenia nie je začiatok práce.');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) errors.push('Doplňte platný začiatok a koniec výkonu.');
  const transport = ['tow', 'transport', 'relocation'].includes(fields.serviceType);
  const needsHandover = transport || fields.realizedItems?.some(item => ['tow', 'transport', 'relocation'].includes(item.kind));
  if (fields.serviceType === 'storage' && !fields.parkingId) errors.push('Vyberte parkovisko uloženia.');
  if (transport && !fields.destination?.trim()) errors.push('Doplňte miesto vykládky.');
  if (attachments.some(file => file.status === 'pending')) errors.push('Počkajte na potvrdenie uloženia všetkých príloh.');
  if (!fields.photoException?.trim()) {
    const hasPhoto = (kind: 'work' | 'handover') => attachments.some(file => file.status === 'ready' && file.kind === kind && file.mimeType.startsWith('image/'));
    if (!hasPhoto('work')) errors.push('Pridajte fotografiu výkonu alebo vysvetlite výnimku.');
    if (needsHandover && !hasPhoto('handover')) errors.push('Pridajte fotografiu odovzdania alebo vysvetlite výnimku.');
  }
  if (pendingReceiptIds.length) errors.push('Najprv potvrďte všetky zaznamenané príjmy hotovosti.');
  return errors;
}
export function canTowingTransition(from: TowingWorkStatus, action: 'start' | 'submit' | 'return' | 'cancel' | 'assign'): boolean {
  if (action === 'start') return from === 'assigned' || from === 'needs_changes';
  if (action === 'submit') return ['assigned', 'in_progress', 'needs_changes'].includes(from);
  if (action === 'return') return from === 'submitted';
  return from !== 'cancelled';
}

function realizedItemProblems(fields: TowingFields, complete: boolean): string[] {
  return (fields.realizedItems ?? []).flatMap((item, index) => {
    const problems: string[] = [];
    const label = `Úkon ${index + 1}`;
    if (item.kind === 'storage' && !item.parkingId) problems.push(`${label}: vyberte konkrétne parkovisko.`);
    if (['tow', 'transport', 'relocation'].includes(item.kind) && !item.destination?.trim()) problems.push(`${label}: doplňte cieľ prepravy.`);
    if (complete && (!/^[0-9]{1,9}(\.[0-9]{1,3})?$/.test(item.quantity) || Number(item.quantity) <= 0 || !item.unit.trim() || !item.description.trim())) problems.push(`${label}: doplňte opis, kladné množstvo a jednotku.`);
    return problems;
  });
}
