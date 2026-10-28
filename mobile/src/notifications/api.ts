import type { MobilePushPreferences, MobilePushType } from "../../../src/lib/mobile-api";
import { MobileApiError, type MobileTransport } from "../lib/api";
import type { MobileConfig } from "../lib/config";

export const PUSH_TYPES: readonly MobilePushType[] = ["tasks", "task_due", "cases", "callbacks_mine", "callbacks_unclaimed", "handoffs", "work", "branch"];
/** Kinds an older server does not know yet (deliveries, work notices); they stay on. */
const OPTIONAL: readonly MobilePushType[] = ["handoffs", "work", "branch"];
export type PushRegistration = {
  installationId: string; token: string; platform: "ios" | "android"; appVersion: string | null;
  preferences?: Partial<MobilePushPreferences>;
};
export type PushApi = {
  register: (body: PushRegistration) => Promise<MobilePushPreferences>;
  unregister: (installationId: string) => Promise<void>;
};

const contractError = () => new MobileApiError("Odpoveď aplikácie sa nepodarilo overiť. Skúste znova.", 502);

/** Registration of this phone for push notifications of the signed-in operator. */
export function createPushApi(config: MobileConfig, getToken: () => Promise<string | null>, transport: MobileTransport = fetch): PushApi {
  async function post(path: string, body: unknown, timeout: number): Promise<Record<string, unknown>> {
    const token = await getToken();
    if (!token) throw new MobileApiError("Prihlásenie vypršalo. Prihláste sa znova.", 401);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await transport(config.apiOrigin + "/api/mobile/v1/push/" + path, {
        method: "POST", credentials: "omit", signal: controller.signal, body: JSON.stringify(body),
        headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": config.environment, "Content-Type": "application/json", Accept: "application/json" },
      });
      let data: unknown;
      try { data = await response.json(); } catch { throw contractError(); }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw contractError();
      const record = data as Record<string, unknown>;
      if (!response.ok) {
        throw new MobileApiError(typeof record.error === "string" ? record.error : "Notifikácie sa nepodarilo nastaviť.", response.status,
          typeof record.code === "string" ? record.code : undefined);
      }
      if (record.ok !== true || record.apiVersion !== 1 || record.environment !== config.environment) throw contractError();
      return record;
    } catch (error) {
      if (error instanceof MobileApiError) throw error;
      throw new MobileApiError("Nepodarilo sa spojiť s aplikáciou. Skontrolujte pripojenie a skúste znova.", 0);
    } finally { clearTimeout(timer); }
  }
  return {
    register: async body => {
      const preferences = (await post("register", body, 12_000)).preferences;
      if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) throw contractError();
      const switches = preferences as Record<string, unknown>;
      // A newer server may add kinds; this app shows the ones it knows.
      if (PUSH_TYPES.some(type => typeof switches[type] !== "boolean" && !(OPTIONAL.includes(type) && switches[type] === undefined))) throw contractError();
      return Object.fromEntries(PUSH_TYPES.map(type => [type, switches[type] ?? true])) as MobilePushPreferences;
    },
    // At logout the phone must not wait long for a server that is away.
    unregister: async installationId => { await post("unregister", { installationId }, 4_000); },
  };
}
