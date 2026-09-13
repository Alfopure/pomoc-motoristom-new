export const handoffStates = ["offered", "accepted", "en_route", "arrived", "completed", "rejected", "cancelled", "expired"] as const;
export type HandoffState = typeof handoffStates[number];
export const handoffLabels: Record<HandoffState, string> = { offered: "Čaká na prijatie", accepted: "Prijaté", en_route: "Na ceste", arrived: "Na mieste", completed: "Dokončené", rejected: "Odmietnuté", cancelled: "Zrušené", expired: "Platnosť skončila" };
export const handoffEventLabels: Record<string, string> = { issue: "Odovzdanie vytvorené", publish: "Údaje aktualizované", renew: "Odkaz obnovený", accept: "Prijaté", reject: "Odmietnuté", en_route: "Na ceste", arrived: "Na mieste", complete: "Dokončené", update: "Aktualizácia", blocked: "Problém pri realizácii", revoke: "Zrušené" };
export type HandoffPlace = { address: string; lat: number | null; lng: number | null };
export type HandoffPublished = {
  caseNumber: string; action: string;
  contact: { name: string; phone: string };
  vehicle: { make: string; model: string; plate: string };
  pickup: HandoffPlace | null; destination: HandoffPlace | null;
  instructions?: string; scheduledAt?: string | null;
};
export type HandoffEvent = { id: string; action: string; comment: string; actor: string; createdAt: string };
export type CaseHandoff = {
  id: string; status: HandoffState; revision: number; publishedVersion: number;
  recipientName: string; recipientPhone?: string; expiresAt: string; createdAt: string;
  canRenew?: boolean;
  openedAt: string | null; eta: string | null; published: HandoffPublished | null; events: HandoffEvent[];
};
export type HandoffContext = { preview: HandoffPublished; previewVersion: string; handoffs: CaseHandoff[] };
export type HandoffCommand = { action: string; commandId: string; expectedRevision?: number; publishedVersion?: number; comment?: string; eta?: string | null; [key: string]: unknown };
export type HandoffReceipt = { handoff: CaseHandoff; commandId?: string; committedRevision?: number; tokenAccepted?: boolean; url?: string };
export function isHandoffReceipt(value: unknown, command: HandoffCommand): value is HandoffReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<HandoffReceipt>, handoff = receipt.handoff;
  return !!handoff && receipt.commandId === command.commandId && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(handoff.id)
    && (!command.handoffId || handoff.id === command.handoffId) && Number.isSafeInteger(receipt.committedRevision) && Number(receipt.committedRevision) >= 1
    && Number.isSafeInteger(handoff.revision) && handoff.revision >= Number(receipt.committedRevision) && Number.isSafeInteger(handoff.publishedVersion) && handoff.publishedVersion >= 1
    && handoffStates.includes(handoff.status);
}
export function handoffIsActive(handoff: Pick<CaseHandoff, "status" | "expiresAt">): boolean {
  return ["offered", "accepted", "en_route", "arrived"].includes(handoff.status) && Date.parse(handoff.expiresAt) > Date.now();
}
