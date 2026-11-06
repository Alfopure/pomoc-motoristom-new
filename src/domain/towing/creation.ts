import type { TowingFields } from './types';

/** One existing towing order. Self creation never accepts a recipient identity. */
export type TowingCreateInput = {
  commandId: string;
  targetId: string;
  mode: 'self' | 'office';
  fields: TowingFields;
  driverId?: string;
  completed?: boolean;
  officeNotes?: string;
};

/** Operational input only; office prices, attribution and billing use their own commands. */
export const towingCreateFieldNames = [
  'serviceType', 'subjectType', 'subjectDescription', 'plate', 'vin', 'pickup', 'destination',
  'contact', 'noContactReason', 'branchId', 'fleetAssetId', 'plannedAt', 'startedAt', 'finishedAt',
  'driverNotes', 'performedQuantity', 'photoException', 'handoverRecipientName', 'handedOverAt',
  'handoverException', 'odometer', 'paymentIntent', 'realizedItems', 'requesterType', 'requesterId',
  'requester', 'owner', 'customer', 'recipient', 'assistanceReference', 'assistancePartnerId', 'parkingId', 'dispatchInstructions',
] as const;
