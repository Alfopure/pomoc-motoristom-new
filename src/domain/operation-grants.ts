/** Web-only publication contract. Never added to the legacy mobile handoff DTO. */
export interface OperationGrantSnapshot {
  kind: 'delivery' | 'collection' | 'transfer';
  caseNumber: string | null;
  vehicle: string | null;
  from: string;
  to: string;
  scheduledAt: string | null;
  recipientName: string;
  customer: { name: string; phone: string } | null;
}
export interface OperationGrant {
  id: string;
  operationId: string;
  recipientName: string;
  expiresAt: string;
  status: 'active' | 'revoked' | 'expired' | 'assignment_changed' | 'outdated';
  createdAt: string;
}
export interface OperationGrantContext {
  preview: OperationGrantSnapshot | null;
  previewVersion: string | null;
  operationRevision: number;
  grants: OperationGrant[];
}
export interface OperationGrantCommand {
  action: 'issue' | 'revoke' | 'recover';
  commandId: string;
  expectedRevision: number;
  previewVersion?: string;
  hours?: number;
  grantId?: string;
  reason?: string;
}
export interface OperationGrantReceipt {
  commandId: string;
  committedRevision: number;
  grant: OperationGrant;
  url?: string;
}
export interface PublicOperationGrant {
  grantId: string;
  operationId: string;
  status: string;
  revision: number;
  expiresAt: string;
  snapshot: OperationGrantSnapshot | null;
}
export interface PublicOperationCommand {
  commandId: string;
  grantId: string;
  action: 'accept' | 'start' | 'arrive' | 'collect' | 'complete';
  expectedRevision: number;
}
