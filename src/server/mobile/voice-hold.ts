import "server-only";
import { nativeVoiceTestEnabled } from "@/lib/app-environment";
import { isUuid } from "@/lib/telephony/uuid";
import type { MobileVoiceHoldInput, MobileVoiceMedia } from "@/lib/mobile-api";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/mutation-error";
import { holdCall, unholdCall } from "@/server/telephony/call-actions";
import { assertNativeHoldAuthority } from "@/server/telephony/native-hold-authority";
import { payloadFingerprint } from "@/server/telephony/provider-journal";
import type { TelephonyRuntimeDeps } from "@/server/telephony/runtime";
import { ownedSessionWork } from "@/server/telephony/session-runner";
import { readPendingEffects } from "@/server/telephony/state/continuation";
import { commandKey, readMeta, telnyxSipUri, toJson, type SessionRow } from "@/server/telephony/state/types";
import { commandId, uuidV5 } from "@/server/telephony/telnyx/command-id";
import { requireNativeLease, requireNativeSession } from "./voice";
export type NativeHoldInput = MobileVoiceHoldInput;
export type NativeMedia = MobileVoiceMedia;
type Receipt = {
    input: NativeHoldInput;
    sessionId: string;
    profileId: string;
    eventId: string;
    customerControlId: string | null;
    rejected: boolean;
};
export function readNativeHoldInput(value: unknown): NativeHoldInput {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new MutationError("Neplatné podržanie hovoru.", 400);
    const body = value as Record<string, unknown>;
    if (Object.keys(body).some(key => !["deviceSessionId", "callControlId", "requestId", "held", "expectedVersion"].includes(key)) ||
        typeof body.deviceSessionId !== "string" || !isUuid(body.deviceSessionId) || typeof body.requestId !== "string" || !isUuid(body.requestId) ||
        typeof body.callControlId !== "string" || !body.callControlId || body.callControlId.length > 1024 || /[\x00-\x20|]/.test(body.callControlId) ||
        typeof body.held !== "boolean" || typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) {
        throw new MutationError("Neplatné podržanie hovoru.", 400);
    }
    return { deviceSessionId: body.deviceSessionId, callControlId: body.callControlId, requestId: body.requestId.toLowerCase(), held: body.held, expectedVersion: body.expectedVersion };
}
function pending(session: SessionRow) {
    const meta = readMeta(session);
    return Boolean(readPendingEffects(session).entries.some(entry => entry.commands.some(command => !entry.completedCommands.includes(commandKey(command)))) || meta.announcement_sequence || meta.recording?.barrier || meta.recording?.pendingAudio);
}
async function journal(deps: TelephonyRuntimeDeps, sessionId: string, id: string, held: boolean, customer: string, conference?: string | null) {
    const { data, error } = await deps.admin.from("motorist_provider_commands").select("*").eq("session_id", sessionId).eq("command_id", id).maybeSingle();
    if (error)
        throw new MutationError("Výsledok podržania sa nepodarilo overiť.", 503);
    if (!data)
        return null;
    const body = data.request_payload as Record<string, unknown> | null;
    const suffix = held ? "hold" : "unhold";
    if (data.method !== "POST" || !new RegExp(`^/conferences/[^/]+/actions/${suffix}$`).test(data.path) ||
        conference !== undefined && data.path !== `/conferences/${encodeURIComponent(conference ?? "")}/actions/${suffix}` ||
        !body || !Array.isArray(body.call_control_ids) || body.call_control_ids.length !== 1 || body.call_control_ids[0] !== customer ||
        data.fingerprint !== payloadFingerprint({ method: data.method, path: data.path, body })) {
        throw new MutationError("Identita podržania sa nezhoduje.", 503);
    }
    return data;
}
/** Initial internal bridge evidence permits audio, never internal hold authority. */
async function directInternalMedia(deps: TelephonyRuntimeDeps, actor: MotoristActor, session: SessionRow, lease: string, unavailable: NativeMedia): Promise<NativeMedia> {
    const meta = readMeta(session);
    const caller = meta.internal?.by;
    const callee = meta.internal?.target_profile_id;
    if (!caller || !callee || caller === callee || ![caller, callee].includes(actor.profileId) ||
        session.organization_id !== actor.organizationId || meta.environment !== deps.environment ||
        session.state !== "talking" || session.answered_by_profile_id !== caller || !session.answered_at || session.conference_id || session.hold_started_at ||
        meta.holdControl || meta.holdRecovery || meta.sdk_hold || meta.conference || meta.consult || meta.transfer || meta.park || pending(session)) return unavailable;
    const callerControl = meta.accepted_device_legs?.[caller];
    const calleeControl = meta.accepted_device_legs?.[callee];
    if (typeof callerControl !== "string" || !callerControl || typeof calleeControl !== "string" || !calleeControl || callerControl === calleeControl) return unavailable;
    const device = await requireNativeLease(deps, actor, lease);
    if (!device.sip_username) return unavailable;
    const result = await deps.admin.from("motorist_call_legs").select("*").eq("organization_id", actor.organizationId).eq("session_id", session.id)
        .in("telnyx_call_control_id", [callerControl, calleeControl]);
    if (result.error) throw new MutationError("Účastníkov hovoru sa nepodarilo overiť.", 503);
    const legs = result.data ?? [];
    if (legs.length !== 2) return unavailable;
    const matches = (profile: string, control: string, intent: string) => legs.find(leg => {
        const state = leg.client_state && typeof leg.client_state === "object" && !Array.isArray(leg.client_state) ? leg.client_state : {};
        return leg.profile_id === profile && leg.telnyx_call_control_id === control && leg.role === "operator" &&
            leg.answered_at && !leg.ended_at && state.intent === intent && state.sid === session.id && state.operatorId === profile;
    });
    const callerLeg = matches(caller, callerControl, "internal_caller");
    const calleeLeg = matches(callee, calleeControl, "internal");
    const own = actor.profileId === caller ? callerLeg : calleeLeg;
    if (!callerLeg || !calleeLeg || own?.to_number !== telnyxSipUri(device.sip_username)) return unavailable;
    const path = `/calls/${encodeURIComponent(callerControl)}/actions/bridge`;
    const proof = await deps.admin.from("motorist_provider_commands").select("*").eq("session_id", session.id).eq("method", "POST")
        .eq("path", path).contains("request_payload", { call_control_id: calleeControl }).limit(2);
    if (proof.error) throw new MutationError("Prepojenie hovoru sa nepodarilo overiť.", 503);
    if (proof.data?.length !== 1) return unavailable;
    const row = proof.data[0];
    if (row.outcome !== "accepted" || row.fingerprint !== payloadFingerprint({ method: row.method, path: row.path, body: row.request_payload })) return unavailable;
    return { version: session.version, state: "active", canHold: false, callControlId: own.telnyx_call_control_id };
}
async function mediaFor(deps: TelephonyRuntimeDeps, actor: MotoristActor, session: SessionRow, lease: string): Promise<NativeMedia> {
    const meta = readMeta(session);
    const rawControl = meta.accepted_device_legs?.[actor.profileId] ?? meta.answered_leg_call_control_id;
    const control = typeof rawControl === "string" && rawControl ? rawControl : null;
    const unavailable: NativeMedia = { version: session.version, state: "unavailable", canHold: false, callControlId: null };
    if (!control || !nativeVoiceTestEnabled() || session.writer_contract !== 2 ||
        session.ended_at || session.termination_requested_at || !["talking", "held"].includes(session.state))
        return unavailable;
    if (session.direction === "internal") return directInternalMedia(deps, actor, session, lease, unavailable);
    if (!["inbound", "outbound"].includes(session.direction)) return unavailable;
    let customerControlId: string;
    try {
        const authority = await assertNativeHoldAuthority(deps, session, { profileId: actor.profileId, deviceSessionId: lease, callControlId: control, expectedVersion: session.version });
        customerControlId = authority.customer.telnyx_call_control_id;
    }
    catch (error) {
        if (error && typeof error === "object" && "status" in error && [403, 409].includes(Number(error.status)))
            return unavailable;
        throw error;
    }
    const result: NativeMedia = { version: session.version, state: "pending", canHold: false, callControlId: control };
    if (pending(session))
        return result;
    const witness = meta.holdControl;
    if (witness) {
        if (typeof witness.held !== "boolean" || typeof witness.commandId !== "string" || !witness.commandId || witness.customerControlId !== customerControlId)
            return unavailable;
        const accepted = await journal(deps, session.id, witness.commandId, witness.held, witness.customerControlId, session.conference_id);
        if (accepted?.outcome !== "accepted" || session.state !== (witness.held ? "held" : "talking"))
            return result;
        return { ...result, state: witness.held ? "held" : "active", canHold: true };
    }
    const recovery = meta.holdRecovery;
    if (recovery) {
        if (recovery.customerControlId !== customerControlId || recovery.operatorControlId !== control) return unavailable;
        const recovered = await deps.admin.from("motorist_provider_commands").select("*").eq("session_id", session.id).eq("command_id", recovery.commandId).maybeSingle();
        if (recovered.error) throw new MutationError("Obnovenie hovoru sa nepodarilo overiť.", 503);
        const row = recovered.data;
        const body = row?.request_payload as Record<string, unknown> | undefined;
        if (row?.outcome !== "accepted" || row.method !== "POST" || row.path !== `/calls/${encodeURIComponent(customerControlId)}/actions/bridge` ||
            body?.call_control_id !== control || row.fingerprint !== payloadFingerprint({ method: row.method, path: row.path, body })) return result;
    }
    return session.state === "talking" ? { ...result, state: "active", canHold: true } : result;
}
export async function readNativeMedia(deps: TelephonyRuntimeDeps, actor: MotoristActor, sessionId: string, lease: string) {
    await requireNativeLease(deps, actor, lease, { cleanup: true });
    const session = await requireNativeSession(deps, actor, sessionId, { readOffer: true });
    return mediaFor(deps, actor, session, lease);
}
async function readReceipt(deps: TelephonyRuntimeDeps, actor: MotoristActor, sessionId: string, input: NativeHoldInput, eventId: string): Promise<Receipt | null> {
    const { data, error } = await deps.admin.from("motorist_call_events").select("normalized_payload").eq("organization_id", actor.organizationId)
        .eq("provider", "telnyx").eq("event_fingerprint", `${eventId}:requested`).maybeSingle();
    if (error)
        throw new MutationError("Pokus o podržanie sa nepodarilo overiť.", 503);
    if (!data)
        return null;
    const receipt = data.normalized_payload as unknown as Receipt;
    if (!receipt || receipt.sessionId !== sessionId || receipt.profileId !== actor.profileId || receipt.eventId !== eventId ||
        payloadFingerprint(receipt.input) !== payloadFingerprint(input) || typeof receipt.rejected !== "boolean" ||
        !(receipt.customerControlId === null || typeof receipt.customerControlId === "string" && receipt.customerControlId.length > 0)) {
        throw new MutationError("Tento pokus už patrí inému príkazu.", 409, "native_hold_identity_conflict");
    }
    return receipt;
}
async function operationOutcome(deps: TelephonyRuntimeDeps, sessionId: string, receipt: Receipt | null) {
    if (!receipt)
        return "not_found" as const;
    if (receipt.rejected)
        return "rejected" as const;
    if (!receipt.customerControlId)
        return "pending" as const;
    const id = commandId({ sessionId, legId: receipt.customerControlId, step: receipt.eventId, intent: receipt.input.held ? "conference:hold" : "conference:unhold" });
    const result = await journal(deps, sessionId, id, receipt.input.held, receipt.customerControlId);
    if (result?.outcome === "accepted")
        return "accepted" as const;
    if (result?.outcome === "rejected")
        return "rejected" as const;
    if (!result && receipt.input.held) {
        // Promotion must precede hold. A definitive refusal of either prerequisite
        // proves this original hold was not dispatched; transport uncertainty does not.
        for (const [legId, intent, path, control] of [
            [receipt.input.callControlId, "conference:create", "/conferences", receipt.input.callControlId],
            [receipt.customerControlId, "conference:join", null, receipt.customerControlId],
        ] as const) {
            const prerequisite = await deps.admin.from("motorist_provider_commands").select("*").eq("session_id", sessionId)
                .eq("command_id", commandId({ sessionId, legId, step: receipt.eventId, intent })).maybeSingle();
            if (prerequisite.error)
                throw new MutationError("Výsledok podržania sa nepodarilo overiť.", 503);
            const row = prerequisite.data;
            const body = row?.request_payload as Record<string, unknown> | undefined;
            if (row?.outcome === "rejected" && row.method === "POST" && body?.call_control_id === control &&
                (path ? row.path === path : /^\/conferences\/[^/]+\/actions\/join$/.test(row.path)) &&
                row.fingerprint === payloadFingerprint({ method: row.method, path: row.path, body }))
                return "rejected" as const;
        }
    }
    return "pending" as const;
}
async function response(deps: TelephonyRuntimeDeps, actor: MotoristActor, id: string, input: NativeHoldInput, receipt: Receipt | null) {
    return { ...await readNativeCallStatus(deps, actor, id, input.deviceSessionId),
        operation: { requestId: input.requestId, held: input.held, outcome: await operationOutcome(deps, id, receipt) } };
}
/** One session snapshot supplies both legacy call fields and media version. */
export async function readNativeCallStatus(deps: TelephonyRuntimeDeps, actor: MotoristActor, id: string, lease: string) {
    const session = await requireNativeSession(deps, actor, id, { readOffer: true });
    return { sessionId: id, state: session.state,
        connected: session.nativeConnected && Boolean(session.answered_at) && ["talking", "held"].includes(session.state) && !session.ended_at && !session.termination_requested_at,
        ended: session.nativeEnded, terminationPending: Boolean(session.termination_requested_at && !session.ended_at),
        media: await mediaFor(deps, actor, session, lease) };
}
function eventIdentity(actor: MotoristActor, sessionId: string, input: NativeHoldInput) {
    return uuidV5(`mobile-hold:${actor.organizationId}:${sessionId}:${actor.profileId}:${input.requestId}`);
}
async function scopedRequestSession(deps: TelephonyRuntimeDeps, actor: MotoristActor, sessionId: string, input: NativeHoldInput) {
    const device = await requireNativeLease(deps, actor, input.deviceSessionId);
    const session = await requireNativeSession(deps, actor, sessionId);
    const meta = readMeta(session);
    const accepted = meta.accepted_device_legs?.[actor.profileId] ?? meta.answered_leg_call_control_id;
    if (!device.sip_username || accepted !== input.callControlId)
        throw new MutationError("Pokus nepatrí tomuto telefónu.", 403);
    const { data, error } = await deps.admin.from("motorist_call_legs").select("id").eq("organization_id", actor.organizationId).eq("session_id", sessionId)
        .eq("profile_id", actor.profileId).eq("role", "operator").eq("to_number", telnyxSipUri(device.sip_username)).eq("telnyx_call_control_id", input.callControlId).maybeSingle();
    if (error)
        throw new MutationError("Účastníka hovoru sa nepodarilo overiť.", 503);
    if (!data)
        throw new MutationError("Pokus nepatrí tomuto telefónu.", 403);
    return session;
}
export async function resolveNativeHold(deps: TelephonyRuntimeDeps, actor: MotoristActor, sessionId: string, value: unknown) {
    const input = readNativeHoldInput(value);
    await scopedRequestSession(deps, actor, sessionId, input);
    const receipt = await readReceipt(deps, actor, sessionId, input, eventIdentity(actor, sessionId, input));
    return response(deps, actor, sessionId, input, receipt);
}
export async function changeNativeHold(deps: TelephonyRuntimeDeps, actor: MotoristActor, sessionId: string, value: unknown) {
    const input = readNativeHoldInput(value);
    await scopedRequestSession(deps, actor, sessionId, input);
    return ownedSessionWork(deps, sessionId, async () => {
        const session = await scopedRequestSession(deps, actor, sessionId, input);
        const identity = { profileId: actor.profileId, deviceSessionId: input.deviceSessionId, callControlId: input.callControlId, expectedVersion: input.expectedVersion };
        const eventId = eventIdentity(actor, sessionId, input);
        let receipt = await readReceipt(deps, actor, sessionId, input, eventId);
        if (receipt && (receipt.rejected || session.version !== input.expectedVersion || await operationOutcome(deps, sessionId, receipt) !== "pending")) {
            return response(deps, actor, sessionId, input, receipt);
        }
        let authority: Awaited<ReturnType<typeof assertNativeHoldAuthority>> | null = null;
        try {
            authority = await assertNativeHoldAuthority(deps, session, identity);
        }
        catch (error) {
            if (!error || typeof error !== "object" || !("code" in error) || error.code !== "native_hold_unavailable")
                throw error;
            // An authenticated original which cannot start receives a durable refusal.
            // Never change the disposition of an already saved, possibly staged request.
        }
        const media = await mediaFor(deps, actor, session, input.deviceSessionId);
        if (!receipt) {
            const rejected = !authority || session.version !== input.expectedVersion || !media.canHold || media.state === (input.held ? "held" : "active");
            receipt = { input, sessionId, profileId: actor.profileId, eventId, customerControlId: authority?.customer.telnyx_call_control_id ?? null, rejected };
            try {
                const inserted = await deps.admin.from("motorist_call_events").insert({ organization_id: actor.organizationId, provider: "telnyx", event_type: "app.native_hold_requested",
                    event_fingerprint: `${eventId}:requested`, normalized_payload: toJson(receipt), payload: {}, raw_payload: {}, handled_status: "processed", received_at: (deps.now?.() ?? new Date()).toISOString() });
                if (inserted.error)
                    receipt = null;
            }
            catch {
                receipt = null;
            }
            // A lost acknowledgement is not permission to mint a second identity.
            if (!receipt)
                receipt = await readReceipt(deps, actor, sessionId, input, eventId);
            if (!receipt)
                throw new MutationError("Uloženie pokusu nie je potvrdené.", 503);
        }
        if (!receipt.rejected && authority && receipt.customerControlId === authority.customer.telnyx_call_control_id && session.version === input.expectedVersion && media.canHold) {
            await (input.held ? holdCall : unholdCall)(deps, actor, sessionId, { id: eventId, nativeHold: { ...identity, customerControlId: receipt.customerControlId } });
        }
        return response(deps, actor, sessionId, input, receipt);
    });
}
