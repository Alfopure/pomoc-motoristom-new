import { normalizeE164 } from "./normalize-e164";

export type CallbackTargetResolution = {
  originalNumber: string;
  dialNumber: string | null;
  status: "original" | "verified_alternative" | "blocked";
  sourceContactId: string | null;
  sourceName: string | null;
  targetContactId: string | null;
  targetName: string | null;
  verificationId: string | null;
};
export type CallbackTargetAuthorization = {
  version: 1; requestId: string; verificationId: string;
  originalNumber: string; targetNumber: string; actorProfileId: string; approvedAt: string;
};

/** This decision is a display/confirmation contract. The server revalidates the
 * same verification before dialing; names never imply a telephone target. */
export function confirmedCallbackTarget(resolution: CallbackTargetResolution, verificationId?: string | null): string | null {
  if (resolution.status === "original") return resolution.originalNumber;
  if (resolution.status !== "verified_alternative" || !resolution.verificationId || verificationId !== resolution.verificationId) return null;
  return normalizeE164(resolution.dialNumber);
}

/** Freeze only an exact request-bound server approval in contact proof. */
export function callbackTargetAuthorization(value: unknown, requestId: string | null, dialedNumber: string | null): CallbackTargetAuthorization | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const item = value as Partial<CallbackTargetAuthorization>;
  if (item.version !== 1 || !requestId || item.requestId !== requestId || typeof item.verificationId !== "string" || !item.verificationId
    || typeof item.actorProfileId !== "string" || !item.actorProfileId || typeof item.approvedAt !== "string" || !Number.isFinite(Date.parse(item.approvedAt))) return;
  const original = normalizeE164(item.originalNumber), target = normalizeE164(item.targetNumber);
  if (!original || !target || target !== normalizeE164(dialedNumber) || original === target) return;
  return { version: 1, requestId, verificationId: item.verificationId, originalNumber: original, targetNumber: target, actorProfileId: item.actorProfileId, approvedAt: item.approvedAt };
}
