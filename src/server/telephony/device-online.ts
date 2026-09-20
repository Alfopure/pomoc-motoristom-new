import type { DeviceRow } from "./state/types";

type DeviceContact = Pick<DeviceRow, "device_seen_at" | "registration_state" | "metadata">;

/** This value is written only from a heartbeat accepted for the current session. */
export const LAST_ONLINE_METADATA_KEY = "last_online_at";

function verifiedTimestamp(value: unknown, now: Date): string | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= now.getTime() ? new Date(at).toISOString() : null;
}

export function deviceLastOnlineAt(device: DeviceContact, now: Date): string | null {
  const metadata = device.metadata && typeof device.metadata === "object" && !Array.isArray(device.metadata) ? device.metadata : {};
  const retained = verifiedTimestamp(metadata[LAST_ONLINE_METADATA_KEY], now);
  // Existing registered rows predate the retained field. A token-issued time or
  // an unregistered/registering heartbeat is not proof that a phone was online.
  const heartbeat = device.registration_state === "registered" ? verifiedTimestamp(device.device_seen_at, now) : null;
  return [retained, heartbeat].filter((value): value is string => value !== null).sort().at(-1) ?? null;
}

/** Preserve the last verified contact before liveness is cleared or downgraded. */
export function retainDeviceLastOnline(device: DeviceContact, now: Date): Record<string, unknown> {
  const metadata = device.metadata && typeof device.metadata === "object" && !Array.isArray(device.metadata) ? device.metadata : {};
  const lastOnlineAt = deviceLastOnlineAt(device, now);
  return { ...metadata, ...(lastOnlineAt ? { [LAST_ONLINE_METADATA_KEY]: lastOnlineAt } : {}) };
}
