import { TelnyxWebphone, type WebphoneSdkClient } from "../../src/lib/telephony/telnyx-webphone";
import { TelnyxRTC } from "./mobile-calling-sdk";

declare global {
  interface Window {
    backgroundPhone: TelnyxWebphone;
    windowTimerFired: boolean;
  }
}

window.backgroundPhone = new TelnyxWebphone({ silent: true, createClient: () => new TelnyxRTC() as unknown as WebphoneSdkClient });
window.backgroundPhone.start();
