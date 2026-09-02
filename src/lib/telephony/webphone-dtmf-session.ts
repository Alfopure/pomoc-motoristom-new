import {
  deliverDtmfTransfer,
  type DtmfTransferDelivery,
  type DtmfTransferPlan,
} from "@/lib/telephony/dtmf-transfer";

export type BrowserDtmfSessionSnapshot = {
  callId: string;
  callStatus: "in_call" | "inactive";
  generation: number;
  session: object | null;
  viptelUniqueId: string;
};

export type BrowserDtmfSessionFence = Readonly<BrowserDtmfSessionSnapshot>;

export function captureBrowserDtmfSession(
  snapshot: BrowserDtmfSessionSnapshot | undefined,
): BrowserDtmfSessionFence {
  if (!snapshot || snapshot.callStatus !== "in_call" || !snapshot.callId || !snapshot.viptelUniqueId) {
    throw new Error("Hovor už nie je spojený alebo nemá bezpečnú identitu pre DTMF prepojenie.");
  }
  return Object.freeze({ ...snapshot });
}

export function assertAuthorizedBrowserDtmfCall(
  fence: BrowserDtmfSessionFence,
  authorizedViptelUniqueId: unknown,
) {
  if (
    typeof authorizedViptelUniqueId !== "string" ||
    authorizedViptelUniqueId !== fence.viptelUniqueId
  ) {
    throw new Error("VIPTel identita autorizovaného hovoru sa zmenila; neodoslal sa žiadny DTMF tón.");
  }
}

export async function deliverFencedBrowserDtmfTransfer(
  plan: DtmfTransferPlan,
  fence: BrowserDtmfSessionFence,
  readCurrent: () => BrowserDtmfSessionSnapshot | undefined,
  sendTone: (tone: string) => Promise<void>,
  options: { intervalMs?: number; wait?: (milliseconds: number) => Promise<void> } = {},
): Promise<DtmfTransferDelivery> {
  return deliverDtmfTransfer(
    plan,
    async (tone) => {
      assertSameSession(fence, readCurrent());
      await sendTone(tone);
    },
    options,
  );
}

function assertSameSession(
  fence: BrowserDtmfSessionFence,
  current: BrowserDtmfSessionSnapshot | undefined,
) {
  if (
    !current ||
    current.callStatus !== "in_call" ||
    current.callId !== fence.callId ||
    current.viptelUniqueId !== fence.viptelUniqueId ||
    current.generation !== fence.generation ||
    current.session !== fence.session
  ) {
    throw new Error("SIP session alebo identita hovoru sa počas DTMF prepojenia zmenila.");
  }
}
