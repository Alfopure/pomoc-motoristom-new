import { describe, expect, it, vi } from "vitest";

import { buildDtmfTransferPlan } from "./dtmf-transfer";
import {
  assertAuthorizedBrowserDtmfCall,
  captureBrowserDtmfSession,
  deliverFencedBrowserDtmfTransfer,
  type BrowserDtmfSessionSnapshot,
} from "./webphone-dtmf-session";

const sessionA = {};
const sessionB = {};

describe("browser DTMF SIP-session fence", () => {
  it("requires the server-authorized provider unique id to match the captured call", () => {
    const fence = captureBrowserDtmfSession(snapshot(sessionA, 1, "call-a", "unique-a"));
    expect(() => assertAuthorizedBrowserDtmfCall(fence, "unique-a")).not.toThrow();
    expect(() => assertAuthorizedBrowserDtmfCall(fence, "unique-b")).toThrow(/identita autorizovaného hovoru/);
    expect(() => assertAuthorizedBrowserDtmfCall(fence, undefined)).toThrow(/identita autorizovaného hovoru/);
  });

  it("sends zero tones when the old call ends and a new call answers during the intent POST", async () => {
    const original = snapshot(sessionA, 1, "call-a", "unique-a");
    const fence = captureBrowserDtmfSession(original);
    let current = snapshot(sessionB, 3, "call-b", "unique-b");
    const sendTone = vi.fn(async () => undefined);

    const delivery = await deliverFencedBrowserDtmfTransfer(
      buildDtmfTransferPlan("blind", "23"),
      fence,
      () => current,
      sendTone,
      { intervalMs: 0 },
    );

    expect(delivery).toMatchObject({ sentToneCount: 0, retryAllowed: true, deliveryUncertain: false });
    expect(sendTone).not.toHaveBeenCalled();
    current = original;
  });

  it("stops as uncertain and non-retryable when the SIP session swaps after the first tone", async () => {
    let current = snapshot(sessionA, 7, "call-a", "unique-a");
    const fence = captureBrowserDtmfSession(current);
    const sendTone = vi.fn(async () => {
      current = snapshot(sessionB, 8, "call-b", "unique-b");
    });

    const delivery = await deliverFencedBrowserDtmfTransfer(
      buildDtmfTransferPlan("blind", "23"),
      fence,
      () => current,
      sendTone,
      { intervalMs: 0 },
    );

    expect(delivery).toMatchObject({
      sentToneCount: 1,
      failedToneIndex: 1,
      retryAllowed: false,
      deliveryUncertain: true,
    });
    expect(sendTone).toHaveBeenCalledTimes(1);
  });

  it("binds both application call id and VIPTel unique id even on the same SIP object", async () => {
    const original = snapshot(sessionA, 2, "call-a", "unique-a");
    const fence = captureBrowserDtmfSession(original);
    const sendTone = vi.fn(async () => undefined);
    const delivery = await deliverFencedBrowserDtmfTransfer(
      buildDtmfTransferPlan("attended", "22"),
      fence,
      () => ({ ...original, viptelUniqueId: "unique-b" }),
      sendTone,
      { intervalMs: 0 },
    );
    expect(delivery.sentToneCount).toBe(0);
    expect(sendTone).not.toHaveBeenCalled();
  });
});

function snapshot(
  session: object,
  generation: number,
  callId: string,
  viptelUniqueId: string,
): BrowserDtmfSessionSnapshot {
  return { callId, callStatus: "in_call", generation, session, viptelUniqueId };
}
