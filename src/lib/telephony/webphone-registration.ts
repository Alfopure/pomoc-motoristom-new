import {
  waitForWebphoneUnregisterResponse,
  type WebphoneUnregisterOutcome,
} from "@/lib/telephony/webphone-unregister";

export const WEBPHONE_REGISTER_RESPONSE_TIMEOUT_MS = 8_000;

type RegisterRequestDelegate = {
  onAccept?: () => void;
  onRedirect?: () => void;
  onReject?: () => void;
};

type RefreshableWebphone = {
  register: (options?: { requestDelegate?: RegisterRequestDelegate }) => Promise<void>;
  unregister: (options?: { all?: boolean; requestDelegate?: RegisterRequestDelegate }) => Promise<void>;
};

type DisconnectableWebphone = RefreshableWebphone & {
  disconnect: () => Promise<void>;
};

export type WebphoneRegistrationOutcome = WebphoneUnregisterOutcome;

export type WebphoneRegistrationRefreshResult = {
  stage: "cancelled_cleanup" | "initial_registration" | "stale_cleanup" | "replacement_registration";
  outcome: WebphoneRegistrationOutcome;
  cancelled?: true;
  cleanedContacts?: "all" | "current";
};

export type WebphoneRegistrationCancellationMode = "none" | "current" | "all";
export type WebphoneDisconnectOutcome = WebphoneUnregisterOutcome | "not_connected";
export type WebphoneDisconnectCompletion = {
  cleanedContacts: "all" | "current" | "none";
  hadSipUser: boolean;
  outcome: WebphoneDisconnectOutcome;
};

export function waitForWebphoneRegisterResponse(
  webphone: Pick<RefreshableWebphone, "register">,
  timeoutMs = WEBPHONE_REGISTER_RESPONSE_TIMEOUT_MS,
): Promise<WebphoneRegistrationOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: WebphoneRegistrationOutcome) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeoutId);
      resolve(outcome);
    };
    const timeoutId = globalThis.setTimeout(() => finish("timed_out"), timeoutMs);

    try {
      void webphone.register({
        requestDelegate: {
          onAccept: () => finish("accepted"),
          onRedirect: () => finish("rejected"),
          onReject: () => finish("rejected"),
        },
      }).catch(() => finish("send_failed"));
    } catch {
      finish("send_failed");
    }
  });
}

/**
 * A hotdesk AOR may retain SIP contacts after a tab or browser crashes. Create
 * the Registerer, clear every contact only after the registrar answers, then
 * register the current browser as the sole live contact.
 */
export async function replaceStaleWebphoneRegistrations(
  webphone: RefreshableWebphone,
  options: { cancellationMode?: () => WebphoneRegistrationCancellationMode } = {},
): Promise<WebphoneRegistrationRefreshResult> {
  const initial = await waitForWebphoneRegisterResponse(webphone);
  const cancellationAfterInitial = options.cancellationMode?.() ?? "none";
  if (cancellationAfterInitial !== "none") {
    return cancelledCleanup(webphone, cancellationAfterInitial);
  }
  if (initial !== "accepted") return { stage: "initial_registration", outcome: initial };

  const cleanup = await unregisterWebphoneContacts(webphone, "all");
  if (cleanup.outcome !== "accepted") {
    return {
      stage: "stale_cleanup",
      outcome: cleanup.outcome,
      ...(cleanup.cleanedContacts ? { cleanedContacts: cleanup.cleanedContacts } : {}),
    };
  }

  // The all-contact cleanup which is already complete also removed this
  // browser's initial Contact. Cancellation at this boundary must not send a
  // replacement REGISTER or a duplicate unregister.
  if ((options.cancellationMode?.() ?? "none") !== "none") {
    return {
      stage: "cancelled_cleanup",
      outcome: "accepted",
      cancelled: true,
      cleanedContacts: "all",
    };
  }

  const replacement = await waitForWebphoneRegisterResponse(webphone);
  const cancellationAfterReplacement = options.cancellationMode?.() ?? "none";
  if (cancellationAfterReplacement !== "none") {
    return cancelledCleanup(webphone, cancellationAfterReplacement);
  }
  if (replacement !== "accepted") {
    return { stage: "replacement_registration", outcome: replacement };
  }
  return { stage: "replacement_registration", outcome: "accepted" };
}

async function cancelledCleanup(
  webphone: RefreshableWebphone,
  mode: Exclude<WebphoneRegistrationCancellationMode, "none">,
): Promise<WebphoneRegistrationRefreshResult> {
  const cleanup = await unregisterWebphoneContacts(webphone, mode);
  return {
    stage: "cancelled_cleanup",
    outcome: cleanup.outcome,
    cancelled: true,
    ...(cleanup.cleanedContacts ? { cleanedContacts: cleanup.cleanedContacts } : {}),
  };
}

async function unregisterWebphoneContacts(
  webphone: Pick<RefreshableWebphone, "unregister">,
  mode: Exclude<WebphoneRegistrationCancellationMode, "none">,
): Promise<{
  cleanedContacts?: Exclude<WebphoneRegistrationCancellationMode, "none">;
  outcome: WebphoneRegistrationOutcome;
}> {
  const current = await waitForWebphoneUnregisterResponse(
    webphone,
    undefined,
    { allContacts: false },
  );
  if (current !== "accepted") return { outcome: current };
  if (mode === "current") return { cleanedContacts: "current", outcome: current };

  const all = await waitForWebphoneUnregisterResponse(
    webphone,
    undefined,
    { allContacts: true },
  );
  return {
    cleanedContacts: all === "accepted" ? "all" : "current",
    outcome: all,
  };
}

/**
 * Serializes teardown with an in-flight registration replacement. Every full
 * AOR cleanup first removes this browser's exact Contact and only then sends
 * the wildcard cleanup for contacts left by crashed tabs. The desired strength
 * is read after every final SIP response, so a concurrent explicit hotdesk
 * handoff can upgrade cleanup without closing the transport early.
 */
export async function completeWebphoneDisconnect(
  webphone: DisconnectableWebphone,
  options: {
    lifecycle?: Promise<WebphoneRegistrationRefreshResult>;
    requestedMode: () => Exclude<WebphoneRegistrationCancellationMode, "none">;
  },
): Promise<WebphoneDisconnectCompletion> {
  const lifecycleResult = options.lifecycle ? await options.lifecycle : undefined;
  let cleanedContacts = lifecycleResult?.cleanedContacts;
  let outcome: WebphoneDisconnectOutcome = lifecycleResult?.outcome ?? "not_connected";
  const lifecycleCleanupFailed = Boolean(
    lifecycleResult &&
    (lifecycleResult.stage === "cancelled_cleanup" || lifecycleResult.stage === "stale_cleanup") &&
    lifecycleResult.outcome !== "accepted",
  );

  while (!lifecycleCleanupFailed) {
    const requestedMode = options.requestedMode();
    if (cleanedContacts === "all" || cleanedContacts === requestedMode) break;
    const cleanupMode = cleanedContacts === "current" ? "all" : "current";
    outcome = await waitForWebphoneUnregisterResponse(
      webphone,
      undefined,
      { allContacts: cleanupMode === "all" },
    );
    if (outcome === "accepted") {
      cleanedContacts = cleanupMode;
      continue;
    }
    // Never claim or attempt an all-contact cleanup unless removal of the
    // current Contact received its own final success response first.
    break;
  }

  await webphone.disconnect().catch(() => undefined);
  return {
    cleanedContacts: cleanedContacts ?? "none",
    hadSipUser: true,
    outcome,
  };
}

/** Map the shared teardown result to the strength required by one caller. */
export function webphoneDisconnectOutcomeForMode(
  completion: WebphoneDisconnectCompletion,
  requiredMode: Exclude<WebphoneRegistrationCancellationMode, "none">,
): WebphoneDisconnectOutcome {
  if (requiredMode !== "all" || completion.cleanedContacts === "all") {
    return completion.outcome;
  }
  // `not_connected` is trustworthy only when no SIP user/contact was ever
  // created. A known weaker teardown must never satisfy an explicit handoff.
  if (!completion.hadSipUser && completion.outcome === "not_connected") {
    return "not_connected";
  }
  return completion.outcome === "rejected" || completion.outcome === "timed_out"
    ? completion.outcome
    : "send_failed";
}
