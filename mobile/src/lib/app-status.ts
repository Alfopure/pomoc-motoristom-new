import type { MobileAppStatus } from "../../../src/lib/mobile-api";
import type { MobileConfig } from "./config";
import type { MobileTransport } from "./api";

/** Public release gate. Any failure resolves to null: an unreachable server never blocks the app. */
export async function fetchAppStatus(config: MobileConfig, transport: MobileTransport = fetch, signal?: AbortSignal): Promise<Pick<MobileAppStatus, "minimumVersion" | "updateUrl"> | null> {
  try {
    const response = await transport(config.apiOrigin + "/api/mobile/v1/app-status", { method: "GET", credentials: "omit", signal, headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const value = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    if (value.ok !== true || value.apiVersion !== 1 || value.environment !== config.environment) return null;
    const minimumVersion = typeof value.minimumVersion === "string" && /^\d{1,4}(?:\.\d{1,4}){0,2}$/.test(value.minimumVersion) ? value.minimumVersion : null;
    let updateUrl: string | null = null;
    try { updateUrl = typeof value.updateUrl === "string" && new URL(value.updateUrl).protocol === "https:" ? value.updateUrl : null; } catch { updateUrl = null; }
    return { minimumVersion, updateUrl };
  } catch { return null; }
}
