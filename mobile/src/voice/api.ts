import type { MobileConfig } from "../lib/config";
import { MobileApiError, type MobileTransport } from "../lib/api";

export type VoiceToken = { token: string; expiresAt: string; deviceSessionId: string };
export type VoiceOffer = { sessionId: string; callControlId: string; direction: "inbound" | "outbound" | "internal"; number: string | null };
export type VoiceOutgoing = { sessionId: string; operatorLegCallControlId: string; to: string };
export type VoiceStatus = { sessionId: string; state: string; connected: boolean; ended: boolean; terminationPending: boolean };

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
  const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
  return {
    token: async (deviceSessionId?: string, takeover = false): Promise<VoiceToken> => {
      const body = await request("token", { deviceSessionId, takeover });
      if (!nonempty(body.token) || !uuid(body.deviceSessionId) || !nonempty(body.expiresAt) || Date.parse(body.expiresAt) <= Date.now() + 60_000 || !Number.isFinite(Date.parse(body.expiresAt))) throw invalid();
      return body as unknown as VoiceToken;
    },
    heartbeat: async (deviceSessionId: string, registrationState: string, nativeVoipRegistered = false) => { await request("heartbeat", { deviceSessionId, registrationState, nativeVoipRegistered }); },
    authorize: async (deviceSessionId: string, identity: { callControlId?: string; providerLegId?: string }): Promise<VoiceOffer> => {
      const body = await request("offers", { deviceSessionId, ...identity });
      if (!uuid(body.sessionId) || !nonempty(body.callControlId) || !["inbound", "outbound", "internal"].includes(String(body.direction)) || !(body.number === null || typeof body.number === "string")) throw invalid();
      return body as unknown as VoiceOffer;
    },
    start: async (deviceSessionId: string, requestId: string, to: string): Promise<VoiceOutgoing> => {
      const body = await request("calls", { deviceSessionId, requestId, to });
      if (!uuid(body.sessionId) || !nonempty(body.operatorLegCallControlId) || !nonempty(body.to)) throw invalid();
      return body as unknown as VoiceOutgoing;
    },
    end: async (deviceSessionId: string, sessionId: string): Promise<{ terminationPending: boolean }> => {
      const body = await request("calls/" + encodeURIComponent(sessionId) + "/end", { deviceSessionId });
      if (body.sessionId !== sessionId || typeof body.terminationPending !== "boolean") throw invalid();
      return { terminationPending: body.terminationPending };
    },
    status: async (deviceSessionId: string, sessionId: string): Promise<VoiceStatus> => {
      const body = await request("calls/" + encodeURIComponent(sessionId) + "/status", { deviceSessionId });
      if (body.sessionId !== sessionId || !nonempty(body.state) || [body.connected, body.ended, body.terminationPending].some(value => typeof value !== "boolean")) throw invalid();
      return body as unknown as VoiceStatus;
    },
    presence: async (deviceSessionId: string, status: "available" | "paused" | "offline") => { await request("presence", { deviceSessionId, status }); },
    disconnect: async (deviceSessionId: string) => { await request("disconnect", { deviceSessionId }); },
  };
}
export type VoiceApi = ReturnType<typeof createVoiceApi>;
