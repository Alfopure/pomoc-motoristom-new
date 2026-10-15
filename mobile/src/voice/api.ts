import type { MobileConfig } from "../lib/config";
import { MobileApiError, type MobileTransport } from "../lib/api";

export type VoiceToken = { token: string; expiresAt: string; deviceSessionId: string };
export type VoiceOffer = { sessionId: string; callControlId: string; direction: "inbound" | "outbound" | "internal"; number: string | null; role: "caller" | "callee"; displayName: string | null };
export type VoiceOutgoing = { sessionId: string; operatorLegCallControlId: string; to: string };
export type VoiceInternalOutgoing = VoiceOutgoing & { targetProfileId: string };
export type VoiceCallTarget = { kind: "external"; number: string } | { kind: "internal"; profileId: string; name: string };
export type VoiceAttemptEnd = { resolved: false; sessionId: null; terminationPending: false } | { resolved: true; sessionId: string; terminationPending: boolean };
export type VoiceMediaState = "active" | "held" | "pending" | "unavailable";
export type VoiceMedia = { version: number; state: VoiceMediaState; canHold: boolean; callControlId: string | null };
export type VoiceStatus = { sessionId: string; state: string; connected: boolean; ended: boolean; terminationPending: boolean; media: VoiceMedia };
export type VoiceHoldCommand = { callControlId: string; requestId: string; held: boolean; expectedVersion: number };
export type VoiceHoldResult = VoiceStatus & { operation: { requestId: string; held: boolean; outcome: "accepted" | "pending" | "rejected" | "not_found" } };

export function createVoiceApi(config: MobileConfig, profileId: string, getToken: () => Promise<string | null>, transport: MobileTransport = fetch) {
  async function request(path: string, body: object): Promise<Record<string, unknown>> {
    const token = await getToken();
    if (!token) throw new MobileApiError("Prihláste sa do aplikácie.", 401);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await transport(config.apiOrigin + "/api/mobile/v1/voice/" + path, {
        method: "POST", credentials: "omit", signal: controller.signal,
        headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": config.environment, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new MobileApiError("Odpoveď telefónu sa nepodarilo overiť.", 502);
      const data = value as Record<string, unknown>;
      if (!response.ok) throw new MobileApiError(typeof data.error === "string" ? data.error : "Telefonovanie sa nepodarilo pripraviť.", response.status, typeof data.code === "string" ? data.code : undefined);
      if (data.ok !== true || data.apiVersion !== 1 || data.environment !== config.environment || data.profileId !== profileId) {
        throw new MobileApiError("Odpoveď telefónu sa nepodarilo overiť.", 502);
      }
      return data;
    } catch (error) {
      if (error instanceof MobileApiError) throw error;
      throw new MobileApiError("Nepodarilo sa spojiť s ústredňou. Skontrolujte pripojenie.", 0);
    } finally { clearTimeout(timer); }
  }
  const invalid = () => new MobileApiError("Odpoveď telefónu sa nepodarilo overiť.", 502);
  const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  const name = (value: unknown): value is string => nonempty(value) && value.length <= 120 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
  const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
  function status(body: Record<string, unknown>, sessionId: string): VoiceStatus {
    if (body.sessionId !== sessionId || !nonempty(body.state) || [body.connected, body.ended, body.terminationPending].some(value => typeof value !== "boolean")) throw invalid();
    const media = body.media;
    if (!media || typeof media !== "object" || Array.isArray(media)) throw invalid();
    const value = media as Record<string, unknown>;
    if (!Number.isSafeInteger(value.version) || (value.version as number) < 0 || typeof value.state !== "string"
      || !["active", "held", "pending", "unavailable"].includes(value.state) || typeof value.canHold !== "boolean"
      || !(value.callControlId === null || nonempty(value.callControlId))) throw invalid();
    if (value.canHold && (!["active", "held"].includes(value.state) || !nonempty(value.callControlId))
      || ["active", "held"].includes(value.state) && (body.connected !== true || body.ended || body.terminationPending)
      || value.state === "active" && body.state !== "talking" || value.state === "held" && body.state !== "held"
      || value.state !== "unavailable" && !nonempty(value.callControlId)) throw invalid();
    return body as unknown as VoiceStatus;
  }
  async function hold(path: string, deviceSessionId: string, sessionId: string, command: VoiceHoldCommand): Promise<VoiceHoldResult> {
    if (!uuid(command.requestId) || !nonempty(command.callControlId) || command.callControlId.length > 512
      || typeof command.held !== "boolean" || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0) throw invalid();
    const requestId = command.requestId.toLowerCase();
    const body = await request("calls/" + encodeURIComponent(sessionId) + "/" + path, { deviceSessionId, ...command, requestId });
    const media = status(body, sessionId).media;
    if (media.callControlId !== null && media.callControlId !== command.callControlId
      || media.version < command.expectedVersion) throw invalid();
    const operation = body.operation;
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw invalid();
    const value = operation as Record<string, unknown>;
    if (value.requestId !== requestId || value.held !== command.held || typeof value.outcome !== "string"
      || !["accepted", "pending", "rejected", "not_found"].includes(value.outcome)) throw invalid();
    return body as unknown as VoiceHoldResult;
  }
  return {
    token: async (deviceSessionId?: string, takeover = false): Promise<VoiceToken> => {
      const body = await request("token", { deviceSessionId, takeover });
      if (!nonempty(body.token) || !uuid(body.deviceSessionId) || !nonempty(body.expiresAt) || Date.parse(body.expiresAt) <= Date.now() + 60_000 || !Number.isFinite(Date.parse(body.expiresAt))) throw invalid();
      return body as unknown as VoiceToken;
    },
    heartbeat: async (deviceSessionId: string, registrationState: string, nativeVoipRegistered = false) => {
      const body = await request("heartbeat", { deviceSessionId, registrationState, nativeVoipRegistered });
      if (body.registrationState !== registrationState) throw invalid();
    },
    authorize: async (deviceSessionId: string, identity: { callControlId?: string; providerLegId?: string }): Promise<VoiceOffer> => {
      const body = await request("offers", { deviceSessionId, ...identity });
      if (!uuid(body.sessionId) || !nonempty(body.callControlId) || typeof body.direction !== "string" || !["inbound", "outbound", "internal"].includes(body.direction) || !(body.number === null || typeof body.number === "string")
        || typeof body.role !== "string" || !["caller", "callee"].includes(body.role) || !(body.displayName === null || name(body.displayName))
        || body.direction === "internal" && (!name(body.displayName) || body.number !== null)
        || body.direction !== "internal" && body.displayName !== null
        || body.direction === "outbound" && body.role !== "caller" || body.direction === "inbound" && body.role !== "callee") throw invalid();
      return body as unknown as VoiceOffer;
    },
    start: async (deviceSessionId: string, requestId: string, to: string): Promise<VoiceOutgoing> => {
      const body = await request("calls", { deviceSessionId, requestId, to });
      if (!uuid(body.sessionId) || !nonempty(body.operatorLegCallControlId) || !nonempty(body.to)) throw invalid();
      return body as unknown as VoiceOutgoing;
    },
    startInternal: async (deviceSessionId: string, requestId: string, targetProfileId: string): Promise<VoiceInternalOutgoing> => {
      const body = await request("calls/internal", { deviceSessionId, requestId, targetProfileId });
      if (!uuid(body.sessionId) || !nonempty(body.operatorLegCallControlId) || !uuid(body.targetProfileId)
        || body.targetProfileId !== targetProfileId || !name(body.to)) throw invalid();
      return body as unknown as VoiceInternalOutgoing;
    },
    cancelAttempt: async (deviceSessionId: string, requestId: string, target: VoiceCallTarget): Promise<VoiceAttemptEnd> => {
      const body = await request("calls/attempt/end", { deviceSessionId, requestId, kind: target.kind,
        ...(target.kind === "internal" ? { targetProfileId: target.profileId } : { to: target.number }) });
      if (body.resolved === false) {
        if (body.sessionId !== null || body.terminationPending !== false) throw invalid();
        return { resolved: false, sessionId: null, terminationPending: false };
      }
      if (body.resolved !== true || !uuid(body.sessionId) || typeof body.terminationPending !== "boolean") throw invalid();
      return { resolved: true, sessionId: body.sessionId, terminationPending: body.terminationPending };
    },
    end: async (deviceSessionId: string, sessionId: string): Promise<{ terminationPending: boolean }> => {
      const body = await request("calls/" + encodeURIComponent(sessionId) + "/end", { deviceSessionId });
      if (body.sessionId !== sessionId || typeof body.terminationPending !== "boolean") throw invalid();
      return { terminationPending: body.terminationPending };
    },
    status: async (deviceSessionId: string, sessionId: string): Promise<VoiceStatus> => {
      const body = await request("calls/" + encodeURIComponent(sessionId) + "/status", { deviceSessionId });
      return status(body, sessionId);
    },
    hold: (deviceSessionId: string, sessionId: string, command: VoiceHoldCommand) => hold("hold", deviceSessionId, sessionId, command),
    holdStatus: (deviceSessionId: string, sessionId: string, command: VoiceHoldCommand) => hold("hold/status", deviceSessionId, sessionId, command),
    presence: async (deviceSessionId: string, status: "available" | "paused" | "offline") => { await request("presence", { deviceSessionId, status }); },
    disconnect: async (deviceSessionId: string) => { await request("disconnect", { deviceSessionId }); },
  };
}
export type VoiceApi = ReturnType<typeof createVoiceApi>;
