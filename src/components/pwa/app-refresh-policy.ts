import type { TelephonyConsole } from "@/components/dispatch/useTelephonyConsole";

/** Reloading closes the WebRTC connection, including an unanswered invite. */
export function isAppRefreshBlocked(telephony: Pick<TelephonyConsole, "phone" | "phoneBar" | "busyAction" | "presenceBusy" | "outboundPending">): boolean {
  return Boolean(
    telephony.phone.call ||
    telephony.phoneBar.active ||
    telephony.phoneBar.offers.length ||
    telephony.phoneBar.supervising ||
    telephony.busyAction ||
    telephony.presenceBusy ||
    telephony.outboundPending ||
    ["requesting_token", "connecting", "reconnecting"].includes(telephony.phone.status)
  );
}
