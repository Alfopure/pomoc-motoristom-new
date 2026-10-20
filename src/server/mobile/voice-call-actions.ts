import "server-only";
import { colleagueBadge } from "@/lib/telephony/colleague-availability";
import { isUuid } from "@/lib/telephony/uuid";
import type { MobileVoiceRecording, MobileVoiceTransferTarget } from "@/lib/mobile-api";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/mutation-error";
import { blindTransfer, listTransferTargets, stopCallRecording } from "@/server/telephony/call-actions";
import { CallActionError } from "@/server/telephony/service-errors";
import { toCallActor, type TelephonyRuntimeDeps } from "@/server/telephony/runtime";
import { summarizeSessionRecording } from "@/server/telephony/state/recording-types";
import { requireNativeLease, requireNativeSession } from "./voice";
import { mobileColleagueName } from "./voice-colleagues";

/** Transfer and recording control for the mobile phone's own call. The web
 * actions run unchanged; the mobile layer only proves that the exact native
 * endpoint holds the connected call. */

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MutationError(message, 400);
  return value as Record<string, unknown>;
}

export function readNativeTransferInput(value: unknown): { deviceSessionId: string; profileId: string } {
  const body = object(value, "Neplatné prepojenie hovoru.");
  if (Object.keys(body).some(key => !["deviceSessionId", "profileId"].includes(key))
    || typeof body.deviceSessionId !== "string" || !isUuid(body.deviceSessionId) || typeof body.profileId !== "string" || !isUuid(body.profileId)) {
    throw new MutationError("Neplatné prepojenie hovoru.", 400);
  }
  return { deviceSessionId: body.deviceSessionId, profileId: body.profileId.toLowerCase() };
}

export function readNativeRecordingInput(value: unknown): { deviceSessionId: string; retry: boolean } {
  const body = object(value, "Neplatný pokyn nahrávania.");
  if (Object.keys(body).some(key => !["deviceSessionId", "retry"].includes(key))
    || typeof body.deviceSessionId !== "string" || !isUuid(body.deviceSessionId) || body.retry !== undefined && typeof body.retry !== "boolean") {
    throw new MutationError("Neplatný pokyn nahrávania.", 400);
  }
  return { deviceSessionId: body.deviceSessionId, retry: body.retry === true };
}

/** A connected call of this exact mobile endpoint, otherwise a plain refusal. A call
 * between colleagues has no customer to hand over, so it is never transferred. */
async function connectedNativeCall(deps: TelephonyRuntimeDeps, actor: MotoristActor, sessionId: string, deviceSessionId: string, use: "transfer" | "recording") {
  await requireNativeLease(deps, actor, deviceSessionId, { cleanup: use === "recording" });
  const session = await requireNativeSession(deps, actor, sessionId);
  if (session.nativeEnded) throw new MutationError("Hovor už skončil.", 409);
  if (!session.nativeConnected) throw new MutationError("Hovor ešte nie je spojený.", 409);
  if (use === "transfer" && session.direction === "internal") throw new MutationError("Hovor s kolegom nemožno prepojiť.", 409, "internal_call");
  return session;
}

export function readNativeLeaseInput(value: unknown): { deviceSessionId: string } {
  const body = object(value, "Neplatná požiadavka telefónu.");
  if (Object.keys(body).some(key => key !== "deviceSessionId") || typeof body.deviceSessionId !== "string" || !isUuid(body.deviceSessionId)) {
    throw new MutationError("Neplatná požiadavka telefónu.", 400);
  }
  return { deviceSessionId: body.deviceSessionId };
}

/** Colleagues who can take this call now; unavailable ones stay listed with the web's badge. */
export async function listNativeTransferTargets(deps: TelephonyRuntimeDeps, actor: MotoristActor, sessionId: string, value: unknown): Promise<{ targets: MobileVoiceTransferTarget[] }> {
  await connectedNativeCall(deps, actor, sessionId, readNativeLeaseInput(value).deviceSessionId, "transfer");
  const targets = await listTransferTargets(deps, toCallActor(actor));
  const now = deps.now?.() ?? new Date();
  return { targets: targets.slice(0, 200).map(target => ({ profileId: target.profileId, displayName: mobileColleagueName(target.displayName),
    available: target.available, label: colleagueBadge(target, now) })) };
}

export async function transferNativeCall(deps: TelephonyRuntimeDeps, actor: MotoristActor, sessionId: string, value: unknown) {
  const input = readNativeTransferInput(value);
  if (input.profileId === actor.profileId.toLowerCase()) throw new MutationError("Hovor nemožno prepojiť na seba.", 400);
  await connectedNativeCall(deps, actor, sessionId, input.deviceSessionId, "transfer");
  try {
    const result = await blindTransfer(deps, toCallActor(actor), sessionId, { profileId: input.profileId });
    return { sessionId: result.sessionId, state: result.state };
  } catch (error) {
    // The web names a colleague's personal number here; the phone only says it cannot be reached.
    if (error instanceof CallActionError && error.code === "destination_not_allowed") throw new MutationError("Kolegu sa teraz nedá zastihnúť. Vyberte iného kolegu.", 409, "target_unavailable");
    throw error;
  }
}

export async function stopNativeRecording(deps: TelephonyRuntimeDeps, actor: MotoristActor, sessionId: string, value: unknown): Promise<{ sessionId: string; recording: MobileVoiceRecording }> {
  const input = readNativeRecordingInput(value);
  await connectedNativeCall(deps, actor, sessionId, input.deviceSessionId, "recording");
  await stopCallRecording(deps, toCallActor(actor), sessionId, input.retry);
  // Report what the session now records, as the web does after a stop; "stopping" stays unconfirmed.
  const session = await requireNativeSession(deps, actor, sessionId, { readOffer: true });
  return { sessionId, recording: summarizeSessionRecording(session.metadata) };
}
