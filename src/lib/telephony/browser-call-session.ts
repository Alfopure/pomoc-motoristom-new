export type BrowserCallSessionStatus = "incoming" | "outgoing" | "in_call";

export type BrowserCallSessionFence = Readonly<{
  generation: number;
  session: unknown;
  status: BrowserCallSessionStatus;
}>;

export function captureBrowserCallSession(input: {
  generation: number;
  session: unknown;
  status: string;
}): BrowserCallSessionFence | undefined {
  if (!isActiveBrowserCallStatus(input.status)) return undefined;
  return {
    generation: input.generation,
    session: input.session,
    status: input.status,
  };
}

export function browserCallSessionFenceMatches(
  fence: BrowserCallSessionFence,
  current: { generation: number; session: unknown; status: string },
  allowedStatuses: readonly BrowserCallSessionStatus[],
) {
  return fence.generation === current.generation &&
    fence.session === current.session &&
    allowedStatuses.includes(current.status as BrowserCallSessionStatus);
}

export function sameBrowserCallSession(
  left: Pick<BrowserCallSessionFence, "generation" | "session"> | undefined,
  right: Pick<BrowserCallSessionFence, "generation" | "session"> | undefined,
) {
  return Boolean(
    left &&
    right &&
    left.generation === right.generation &&
    left.session === right.session,
  );
}

/**
 * Remount key for UI bound to one browser SIP dialog.
 *
 * The session generation increments once per dialog, so two consecutive calls
 * to the same party number produce different keys even before a provider row
 * exists. Keying such UI by caller number instead lets per-call state (a
 * transfer lock, a hangup error, a duration counter) survive into the next
 * call because React never remounts the component.
 */
export function browserCallSessionKey(
  fence: Pick<BrowserCallSessionFence, "generation"> | undefined,
) {
  return fence ? `browser-call-${fence.generation}` : undefined;
}

function isActiveBrowserCallStatus(value: string): value is BrowserCallSessionStatus {
  return value === "incoming" || value === "outgoing" || value === "in_call";
}
