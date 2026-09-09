/** Confirmation of the customer/operator connection, separate from SIP answer. */
export type AudioConnectionView = {
  status: "connecting" | "connected" | "failed";
  startedAt: string;
  confirmedAt: string | null;
  error: string | null;
};

/** A pending connection stays retryable, but the console must surface the delay. */
export const AUDIO_CONNECTION_WARNING_MS = 30_000;
