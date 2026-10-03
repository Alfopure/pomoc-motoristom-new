"use client";

import { TelnyxRTC as ProviderTelnyxRTC } from "@telnyx/webrtc";

/** Observe the SDK's fire-and-forget keepalives without changing RPC results. */
export class TelnyxRTC extends ProviderTelnyxRTC {
  override execute(message: Parameters<ProviderTelnyxRTC["execute"]>[0]): ReturnType<ProviderTelnyxRTC["execute"]> {
    const request = super.execute(message);
    if (message.request.method === "telnyx_rtc.ping") {
      // In 2.27.10, VertoHandler's ping reply and BaseSession's keepalive timer
      // discard this Promise. Socket replacement/close rejects it with a
      // StaleRequestError; a timeout rejects it after SDK signaling recovery.
      // Observe that rejection here, leaving the original Promise available
      // to callers and all non-keepalive failures unchanged.
      void request.catch(() => undefined);
    }
    return request;
  }
}
