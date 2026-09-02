import { createHash } from "node:crypto";

import type { Json } from "@/lib/supabase/database.types";
import type { JobName, JobSchedule } from "./types";

const UUID_NAMESPACE = "f96bf3e3-7e77-5b60-b58a-7dbab3e4fc7c";

export function scheduledSlot(nowMs: number, schedule: JobSchedule) {
  const slotMs = Math.floor((nowMs - schedule.offsetMs) / schedule.everyMs) * schedule.everyMs + schedule.offsetMs;
  return new Date(slotMs);
}

export function scheduledRunId(jobName: JobName, scheduledFor: Date) {
  return uuidV5(UUID_NAMESPACE, `${jobName}:${scheduledFor.toISOString()}`);
}

export function manualRunId(jobName: JobName, idempotencyKey: string) {
  return uuidV5(UUID_NAMESPACE, `${jobName}:manual:${idempotencyKey}`);
}

export function payloadHash(payload: Json) {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export function retryDelayMs(attempt: number) {
  const exponent = Math.max(0, Math.min(attempt - 1, 6));
  return Math.min(15 * 60_000, 15_000 * 2 ** exponent);
}

export function stableStringify(value: Json): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key] ?? null)}`)
    .join(",")}}`;
}

function uuidV5(namespace: string, name: string) {
  const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const digest = createHash("sha1").update(namespaceBytes).update(name).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
