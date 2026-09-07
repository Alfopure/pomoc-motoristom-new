import type { SmsTemplateContext, SmsTemplateKey } from "./templates";

export type SmsActor = { organizationId: string; actorProfileId: string };
export type SmsPrepareInput = {
  requestId: string;
  caseId?: string | null;
  toNumber?: string;
  template: SmsTemplateKey | "custom";
  callbackNumber?: string;
  etaMinutes?: number;
  technicianDeparted?: boolean;
  towAddress?: string;
  message?: string;
  taskId?: string | null;
  replyToMessageId?: string | null;
};
export type PreparedSms = SmsActor & {
  version: 1;
  requestId: string;
  caseId: string | null;
  contactId: string | null;
  caseNumber: string | null;
  recipientName: string;
  toNumber: string;
  template: SmsPrepareInput["template"];
  templateContext: SmsTemplateContext;
  message: string;
  sender: string;
  messagingProfileId: string | null;
  locationToken: string | null;
  locationLinkId: string | null;
  taskId: string | null;
  expiresAt: string;
  replyToMessageId?: string | null;
  repliesEnabled?: boolean;
  repliesPendingVerification?: boolean;
};
export type SmsPreview = { draft: PreparedSms; proof: string };
export type SmsCaseOption = { id: string; caseNumber: string; name: string; phone: string; validPhone: boolean };
export type SmsHistoryEntry = {
  id: string;
  caseId: string | null;
  caseNumber: string | null;
  recipientName: string;
  toNumber: string;
  author: string;
  body: string;
  sender: string;
  createdAt: string;
  status: string;
  statusDetail: string | null;
  error: string | null;
  template: string | null;
  direction?: "inbound" | "outbound";
  location: null | {
    status: string;
    expiresAt: string;
    submittedAt?: string;
    accuracy?: number | null;
    lat?: number;
    lng?: number;
  };
};

export type SmsInboxMessage = {
  id: string;
  version: string;
  from: string;
  to: string;
  body: string;
  createdAt: string;
  unread: boolean;
  caseId: string | null;
  caseNumber: string | null;
  assignedProfileId: string | null;
  assignedName: string | null;
  canReply: boolean;
  hasMedia: boolean;
};
export type SmsConversationEntry = {
  id: string;
  body: string;
  direction: "inbound" | "outbound";
  createdAt: string;
  status: string;
  statusDetail: string | null;
  caseId: string | null;
  caseNumber: string | null;
};
