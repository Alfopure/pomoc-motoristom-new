import { describe, expect, it, vi } from "vitest";

import { buildDtmfTransferPlan, deliverDtmfTransfer } from "./dtmf-transfer";

describe("buildDtmfTransferPlan", () => {
  it("builds the documented blind-transfer tones for an internal extension", () => {
    expect(buildDtmfTransferPlan("blind", "23")).toEqual({
      mode: "blind",
      target: "23",
      tones: ["#", "#", "2", "3"],
    });
  });

  it("builds the documented attended-transfer tones and normalizes an external number", () => {
    expect(buildDtmfTransferPlan("attended", "+421 905 123 456")).toEqual({
      mode: "attended",
      target: "0905123456",
      tones: ["*", "2", "0", "9", "0", "5", "1", "2", "3", "4", "5", "6"],
    });
  });

  it("rejects an invalid target before sending any tone", () => {
    expect(() => buildDtmfTransferPlan("blind", "23#9")).toThrow("valid phone number");
  });
});

describe("deliverDtmfTransfer", () => {
  it("sends every tone exactly once in order", async () => {
    const sendTone = vi.fn(async (tone: string) => {
      void tone;
    });
    const wait = vi.fn(async (milliseconds: number) => {
      void milliseconds;
    });
    const plan = buildDtmfTransferPlan("blind", "23");

    await expect(deliverDtmfTransfer(plan, sendTone, { intervalMs: 180, wait })).resolves.toEqual({
      complete: true,
      deliveryUncertain: false,
      retryAllowed: false,
      sentToneCount: 4,
      totalToneCount: 4,
    });
    expect(sendTone.mock.calls.map(([tone]) => tone)).toEqual(["#", "#", "2", "3"]);
    expect(wait).toHaveBeenCalledTimes(3);
  });

  it("allows retry only when the first tone could not be sent", async () => {
    const sendTone = vi.fn(async () => {
      throw new Error("SIP session ended");
    });

    await expect(deliverDtmfTransfer(buildDtmfTransferPlan("blind", "23"), sendTone, { intervalMs: 0 })).resolves.toMatchObject({
      complete: false,
      deliveryUncertain: false,
      failedToneIndex: 0,
      retryAllowed: true,
      sentToneCount: 0,
    });
    expect(sendTone).toHaveBeenCalledTimes(1);
  });

  it("marks a partial sequence uncertain and never retries a failed tone", async () => {
    const sendTone = vi.fn(async (tone: string) => {
      if (tone === "2") throw new Error("media failure");
    });

    await expect(deliverDtmfTransfer(buildDtmfTransferPlan("attended", "23"), sendTone, { intervalMs: 0 })).resolves.toMatchObject({
      complete: false,
      deliveryUncertain: true,
      failedToneIndex: 1,
      retryAllowed: false,
      sentToneCount: 1,
      totalToneCount: 4,
    });
    expect(sendTone.mock.calls.map(([tone]) => tone)).toEqual(["*", "2"]);
  });
});
