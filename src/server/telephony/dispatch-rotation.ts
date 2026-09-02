import "server-only";

import { DISPATCH_QUEUE_NUMBERS } from "./dispatch-queues";

/**
 * Our record of the PBX rotation the provider owns.
 *
 * VIPTel advances a waiting caller from one dispatch queue to the next on its
 * own timer; the application must not reproduce that. This value exists so the
 * fallback timer can be checked against reality, and so the coverage window can
 * be described to a manager. It is never used to drive routing: the packing
 * rule is ordinal and has no time constant, which is why moving from 30 to 20
 * seconds needs no code change.
 */

export const VIPTEL_ROTATION_CONFIG_KEY = "inboundRotation";
/** Current provider setting, confirmed by the operator on 2026-09-01. */
export const DEFAULT_VIPTEL_ROTATION_SECONDS = 30;
export const MIN_VIPTEL_ROTATION_SECONDS = 5;
export const MAX_VIPTEL_ROTATION_SECONDS = 300;

export type ViptelRotationSettings = {
  periodSeconds: number;
  queueCount: number;
  /** True when the final queue loops rather than ending the rotation. */
  finalQueueLoops: boolean;
};

export function parseViptelRotationSettings(config: unknown): ViptelRotationSettings {
  const raw = config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)[VIPTEL_ROTATION_CONFIG_KEY]
    : undefined;
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const period = Number(record.periodSeconds);
  const periodSeconds = Number.isInteger(period) &&
    period >= MIN_VIPTEL_ROTATION_SECONDS &&
    period <= MAX_VIPTEL_ROTATION_SECONDS
    ? period
    : DEFAULT_VIPTEL_ROTATION_SECONDS;
  return {
    periodSeconds,
    queueCount: DISPATCH_QUEUE_NUMBERS.length,
    finalQueueLoops: record.finalQueueLoops === true,
  };
}

/**
 * How long a caller can ring operators before the rotation runs out.
 * Expressed as queue count times period -- never a literal.
 */
export function dispatchCoverageWindowSeconds(rotation: ViptelRotationSettings): number | null {
  return rotation.finalQueueLoops ? null : rotation.queueCount * rotation.periodSeconds;
}

export type FallbackRotationVerdict =
  | { level: "ok" }
  | { level: "advisory"; message: string }
  | { level: "invalid"; message: string };

/**
 * Checks the fallback delay against the rotation.
 *
 * Only the unambiguous case is fatal. This setting is our record of
 * provider-owned behaviour and can be stale, so everything else is advice
 * rather than a block.
 */
export function validateFallbackAgainstRotation(
  afterSeconds: number,
  rotation: ViptelRotationSettings,
): FallbackRotationVerdict {
  if (afterSeconds < rotation.periodSeconds) {
    return {
      level: "invalid",
      message: `Čas záložného presmerovania musí byť aspoň jedno kolo rotácie (${rotation.periodSeconds} s). ` +
        "Inak sa volajúci presmeruje skôr, než dozvoní prvé pracovisko.",
    };
  }
  const window = dispatchCoverageWindowSeconds(rotation);
  if (window !== null && afterSeconds > window) {
    return {
      level: "advisory",
      message: `Po ${window} s už rotácia nikoho nezvoní, ale záložné presmerovanie nastane až po ${afterSeconds} s.`,
    };
  }
  if (afterSeconds % rotation.periodSeconds !== 0) {
    return {
      level: "advisory",
      message: `Záložné presmerovanie nastane uprostred kola rotácie (${rotation.periodSeconds} s).`,
    };
  }
  return { level: "ok" };
}
