/** Isolated towing DTOs. Amounts are integer EUR cents; quantities/prices are decimal strings. */
export type TowingRole = 'driver' | 'dispatch' | 'billing' | 'manager' | 'delivery';
export type TowingCapability = 'drive' | 'operate' | 'price' | 'bill' | 'cash' | 'correct' | 'members' | 'documents' | 'report' | 'deliver';
export type TowingView = 'office' | 'driver';
export type TowingWorkStatus = 'draft' | 'assigned' | 'in_progress' | 'submitted' | 'needs_changes' | 'cancelled';
export type TowingBillingStatus = 'not_ready' | 'ready' | 'invoiced' | 'not_required';
export type TowingPaymentStatus = 'unpriced' | 'unpaid' | 'partial' | 'paid' | 'overpaid';
export type TowingServiceType = 'tow' | 'repair' | 'transport' | 'storage' | 'relocation';
export interface TowingMember { id: string; userId: string; organizationId: string; displayName: string; roles: TowingRole[]; capabilities: TowingCapability[]; active: boolean; version: number; email?: string; passwordCompleted?: boolean }
export interface TowingParty { name: string; phone?: string; email?: string; address?: string; companyId?: string; taxId?: string }
export interface TowingFields {
  serviceType: TowingServiceType; subjectType: 'vehicle' | 'machine' | 'material'; subjectDescription: string;
  plate?: string; vin?: string; pickup: string; destination?: string; contact?: string; noContactReason?: string;
  branchId?: string; fleetAssetId?: string; plannedAt?: string; startedAt?: string; finishedAt?: string;
  startSource?: 'assignment' | 'manual'; driverNotes?: string; performedQuantity?: string; photoException?: string;
  requester?: TowingParty; owner?: TowingParty; customer?: TowingParty; recipient?: TowingParty;
  assistanceReference?: string; assistancePartnerId?: string; assistancePartnerName?: string; parkingId?: string; parkingName?: string; parkingAddress?: string;
}
export interface TowingLine { id: string; description: string; quantity: string; unit: string; unitPrice: string; taxRate: string; netCents?: number; taxCents?: number; totalCents?: number }
export interface TowingAttachment { id: string; kind: 'work' | 'handover' | 'scan'; name: string; mimeType: string; size: number; status: 'pending' | 'ready' | 'abandoned'; createdAt: string }
export interface TowingDocument { id: string; version: number; kind: 'work' | 'priced'; status: 'generating' | 'ready' | 'failed'; snapshot: Record<string, unknown>; snapshotHash: string; createdAt: string }
export interface TowingPayment { id: string; receiptId: string; amountCents: number; method: 'cash' | 'card' | 'bank' | 'other'; driverId: string | null; createdAt: string; reversalOf?: string | null }
export interface TowingInvoice { id: string; number: string; date: string; amountCents: number; supersedesId?: string; reason?: string }
export interface TowingOrder {
  id: string; number: string; sourceCaseId: string | null; revision: number; assignmentGeneration: number;
  driverId: string | null; workStatus: TowingWorkStatus; billingStatus: TowingBillingStatus; paymentStatus: TowingPaymentStatus;
  fields: TowingFields; authorizedCollectionCents: number | null; receivedCents: number; dueCents: number | null;
  reconciliationRequired: boolean; createdAt: string; updatedAt: string; attachments: TowingAttachment[];
  officeNotes?: string; taxDate?: string | null; lines?: TowingLine[]; documents?: TowingDocument[]; payments?: TowingPayment[]; invoices?: TowingInvoice[]; events?: TowingEvent[]; reconciliations?: TowingReconciliation[];
}
export interface TowingEvent { id: string; action: string; actorId: string; createdAt: string; payload: Record<string, unknown> }
export interface TowingCashAccount { id: string; driverId: string | null; balanceCents: number; reservedCents: number; revision: number }
export interface TowingHandover { id: string; driverId: string; amountCents: number; status: 'pending' | 'accepted' | 'rejected' | 'cancelled'; revision: number; reason?: string; createdAt: string }
export interface TowingReference { id: string; name: string }
export interface TowingWorkspace {
  actor: TowingMember; view: TowingView; orders: TowingOrder[]; members: TowingMember[]; branches: TowingReference[]; fleet: TowingReference[];
  parking?: { id: string; name: string; address: string; active: boolean; revision: number }[]; partners?: TowingReference[];
  totalCount?: number; summary?: { approvedCents: number; invoicedCents: number; receivedCents: number; dueCents: number };
  cashAccounts: TowingCashAccount[]; handovers: TowingHandover[]; taxConfigured: boolean; taxRates: string[]; taxDate: string | null;
}
export const TOWING_COMMANDS = ['create_order','refresh_source','update_order','assign','start','submit','return','cancel','set_lines','approve_price','set_invoice','not_required','receive_payment','propose_handover','accept_handover','reject_handover','cancel_handover','correct_payment','refund_payment','reconcile_receipt','attachment_intent','abandon_attachment','attachment_finalize','issue_document','document_result','email_intent','email_result','set_member','set_tax_config','set_parking'] as const;
export type TowingCommandType = typeof TOWING_COMMANDS[number];
export interface TowingCommand { commandId: string; type: TowingCommandType; targetId: string; expectedRevision?: number; assignmentGeneration?: number; payload: Record<string, unknown> }
export interface TowingCommandResult { commandId: string; targetId: string; revision: number; result?: Record<string, unknown> }
export interface TowingActorContext { userId: string; organizationId: string; membershipId: string; membershipVersion: number }
export interface TowingReconciliation { id: string; receiptId: string | null; status: 'open' | 'resolved'; reason: string; evidence: string | null; paymentId: string | null; resolvesId: string | null; createdAt: string }
export interface TowingReport {
  from: string; to: string;
  performance: { count: number; amountCents: number };
  invoices: { count: number; amountCents: number };
  receipts: { count: number; amountCents: number };
  daily: { date: string; performanceCents: number; invoicedCents: number; receivedCents: number }[];
}
