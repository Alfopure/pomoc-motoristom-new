import { formatViptelDialTarget } from "@/lib/telephony/phone";

export type DtmfTransferMode = "blind" | "attended";

export type DtmfTransferPlan = {
  mode: DtmfTransferMode;
  target: string;
  tones: string[];
};

export type DtmfTransferDelivery = {
  complete: boolean;
  deliveryUncertain: boolean;
  error?: string;
  failedToneIndex?: number;
  retryAllowed: boolean;
  sentToneCount: number;
  totalToneCount: number;
};

const TRANSFER_PREFIX: Record<DtmfTransferMode, string> = {
  attended: "*2",
  blind: "##",
};

/**
 * VIPTel documents *2 + destination for an attended transfer and ## +
 * destination for a blind transfer. The PBX does not expose a confirmation
 * event for this browser-sent sequence, so callers must treat a completed send
 * as accepted/unconfirmed rather than a confirmed transfer.
 */
export function buildDtmfTransferPlan(mode: DtmfTransferMode, rawTarget: unknown): DtmfTransferPlan {
  if (mode !== "blind" && mode !== "attended") {
    throw new Error("Neplatný spôsob prepojenia hovoru.");
  }

  const target = formatViptelDialTarget(rawTarget, "Cieľ prepojenia");
  const tones = `${TRANSFER_PREFIX[mode]}${target}`.split("");

  return { mode, target, tones };
}

/**
 * Sends every tone at most once. If sending fails after at least one tone, the
 * PBX can already be in transfer mode; automatic retry would risk duplicate or
 * malformed input and is therefore intentionally forbidden.
 */
export async function deliverDtmfTransfer(
  plan: DtmfTransferPlan,
  sendTone: (tone: string) => Promise<void>,
  options: {
    intervalMs?: number;
    wait?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<DtmfTransferDelivery> {
  const intervalMs = options.intervalMs ?? 180;
  const wait = options.wait ?? delay;
  let sentToneCount = 0;

  for (let index = 0; index < plan.tones.length; index += 1) {
    if (index > 0 && intervalMs > 0) {
      await wait(intervalMs);
    }

    try {
      await sendTone(plan.tones[index]);
      sentToneCount += 1;
    } catch (error) {
      return {
        complete: false,
        deliveryUncertain: sentToneCount > 0,
        error: error instanceof Error ? error.message : "DTMF tón sa nepodarilo odoslať.",
        failedToneIndex: index,
        retryAllowed: sentToneCount === 0,
        sentToneCount,
        totalToneCount: plan.tones.length,
      };
    }
  }

  return {
    complete: true,
    deliveryUncertain: false,
    retryAllowed: false,
    sentToneCount,
    totalToneCount: plan.tones.length,
  };
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
