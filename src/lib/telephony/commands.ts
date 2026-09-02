import {
  isTelephonyTimeout,
  telephonyFetch,
  TELEPHONY_TIMEOUT_MS,
} from "@/lib/telephony/client-request";
import type {
  BrowserSipCallAttempt,
  BrowserSipFinalResponse,
} from "@/lib/telephony/webphone-call-attempt";

export type TelephonyCommandStatus = "queued" | "sent" | "accepted" | "failed" | "confirmed_by_event";

export type TelephonyCommandReceipt = {
  id: string;
  status: TelephonyCommandStatus;
  commandType?: string;
  error?: string;
  deliveryUncertain?: boolean;
  confirmedAt?: string;
  updatedAt?: string;
};

export type TelephonyTransferTarget = {
  profileId: string;
  operatorName: string;
  extensionId: string;
  extension: string;
};

export type TelephonyRedirectDestination =
  | { destinationProfileId: string; destinationNumber?: never }
  | { destinationNumber: string; destinationProfileId?: never };

export async function waitForTelephonyCommand(
  commandId: string,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    onUpdate?: (receipt: TelephonyCommandReceipt) => void;
    retryTransientErrors?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<TelephonyCommandReceipt & { timedOut?: boolean }> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollMs = options.pollMs ?? 700;
  const deadline = Date.now() + timeoutMs;
  let lastReceipt: TelephonyCommandReceipt = { id: commandId, status: "queued" };
  let observedReceipt = false;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error("Kontrola telefónneho príkazu bola zrušená.");
    try {
      // The loop guard alone is not a bound: it is only evaluated between
      // iterations. Without a per-request budget one response that never
      // arrives pins this call forever, and with it every caller's pending
      // flag - the module-wide busy lock, the queue availability spinner and
      // the waiting-call pickup all sit behind this await.
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const response = await telephonyFetch(
        `/api/telephony/commands/${encodeURIComponent(commandId)}`,
        {
          label: "stav príkazu",
          signal: options.signal,
          timeoutMs: Math.min(TELEPHONY_TIMEOUT_MS.read, remainingMs),
        },
      );
      const result = (await response.json().catch(() => null)) as { command?: TelephonyCommandReceipt; error?: string } | null;
      if (!response.ok || !result?.command) {
        throw new Error(result?.error ?? "Stav telefónneho príkazu sa nepodarilo overiť.");
      }

      lastReceipt = result.command;
      observedReceipt = true;
      options.onUpdate?.(lastReceipt);
      if (lastReceipt.status === "confirmed_by_event" || lastReceipt.status === "failed") {
        return lastReceipt;
      }
      lastError = undefined;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // A per-request timeout is transient by construction and is deliberately
      // NOT recorded as `lastError`. The overall deadline still bounds this
      // call, and falling through to `timedOut` keeps the fail-closed "sent but
      // unconfirmed, refresh before retrying" wording rather than surfacing a
      // transport error for a command VIPTel may in fact have executed.
      if (isTelephonyTimeout(error)) continue;
      if (!options.retryTransientErrors) throw error;
      lastError = error;
    }
    await delay(pollMs, options.signal);
  }

  if (!observedReceipt && lastError) throw lastError;
  return { ...lastReceipt, timedOut: true };
}

export function requireConfirmedTelephonyCommand(receipt: TelephonyCommandReceipt & { timedOut?: boolean }) {
  if (receipt.status === "confirmed_by_event") return receipt;
  if (receipt.status === "failed") {
    throw new Error(receipt.error ?? "VIPTel príkaz nebol potvrdený.");
  }
  throw new Error("Príkaz bol odoslaný, ale VIPTel ho zatiaľ nepotvrdil. Pred opakovaním obnov stav.");
}

export async function runAuditedBrowserSipInvite(
  commandId: string,
  invite: () => Promise<void>,
): Promise<void>;
export async function runAuditedBrowserSipInvite<T>(
  commandId: string,
  invite: () => Promise<T>,
): Promise<T>;
export async function runAuditedBrowserSipInvite<T>(
  commandId: string,
  invite: () => Promise<T>,
): Promise<T> {
  try {
    return await invite();
  } catch (inviteError) {
    try {
      const response = await telephonyFetch("/api/telephony/call/create", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId }),
        label: "uzavretie neodoslaného hovoru",
        timeoutMs: TELEPHONY_TIMEOUT_MS.control,
      });
      const result = (await response.json().catch(() => null)) as {
        command?: { id?: string; status?: string };
        error?: string;
        ok?: boolean;
      } | null;
      if (!response.ok || !result?.ok || result.command?.status !== "failed") {
        throw new Error(result?.error ?? "Neodoslaný hovor sa nepodarilo bezpečne uzavrieť.");
      }
    } catch {
      throw new Error(
        "Hovor sa nepodarilo začať a jeho stav sa nepodarilo bezpečne uzavrieť. Hovor neopakuj, kým neobnovíš stav pracoviska.",
      );
    }
    throw inviteError;
  }
}

export async function confirmAuditedBrowserSipCall(
  commandId: string,
  attempt: BrowserSipCallAttempt,
  options: {
    confirmationTimeoutMs?: number;
    graceTimeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<TelephonyCommandReceipt> {
  const controller = new AbortController();
  const commandResult = waitForTelephonyCommand(commandId, {
    pollMs: options.pollMs,
    retryTransientErrors: true,
    signal: controller.signal,
    timeoutMs: options.confirmationTimeoutMs ?? 75_000,
  }).catch(() => {
    throw unconfirmedBrowserSipMessage();
  });
  const first = await Promise.race([
    commandResult.then((receipt) => ({ source: "command" as const, receipt })),
    attempt.finalResponse.then((response) => ({ source: "sip" as const, response })),
  ]);

  if (first.source === "command") {
    if (first.receipt.status === "confirmed_by_event") return first.receipt;
    if (first.receipt.status === "failed") return requireConfirmedTelephonyCommand(first.receipt);
    throw unconfirmedBrowserSipMessage();
  }

  if (first.response.outcome === "accepted") {
    const receipt = await commandResult;
    if (receipt.status === "confirmed_by_event") return receipt;
    if (receipt.status === "failed") return requireConfirmedTelephonyCommand(receipt);
    throw unconfirmedBrowserSipMessage();
  }

  controller.abort();
  const graceReceipt = await waitForTelephonyCommand(commandId, {
    pollMs: options.pollMs ?? 250,
    retryTransientErrors: true,
    timeoutMs: options.graceTimeoutMs ?? 1_500,
  });
  if (graceReceipt.status === "confirmed_by_event") return graceReceipt;
  if (graceReceipt.status === "failed" && graceReceipt.deliveryUncertain !== true) {
    return requireConfirmedTelephonyCommand(graceReceipt);
  }
  return reconcileAuditedBrowserSipInvite(commandId, first.response);
}

async function reconcileAuditedBrowserSipInvite(
  commandId: string,
  browserReport: Exclude<BrowserSipFinalResponse, { outcome: "accepted" }>,
): Promise<TelephonyCommandReceipt> {
  let response: Response;
  try {
    response = await telephonyFetch("/api/telephony/call/create", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        browserReport,
        commandId,
        outcome: "reconcile",
      }),
      label: "zosúladenie hovoru",
      timeoutMs: TELEPHONY_TIMEOUT_MS.control,
    });
  } catch {
    throw new Error(
      pendingAuditRecoveryMessage(),
    );
  }
  const result = (await response.json().catch(() => null)) as {
    command?: TelephonyCommandReceipt;
    error?: string;
    ok?: boolean;
  } | null;
  if (!response.ok || !result?.ok || !result.command) {
    const detail = result?.error?.trim();
    throw new Error(detail ? `${detail} ${pendingAuditRecoveryMessage()}` : pendingAuditRecoveryMessage());
  }
  if (result.command.status === "confirmed_by_event") return result.command;
  if (result.command.status === "failed" && result.command.deliveryUncertain !== true) {
    throw new Error(retryableBrowserSipMessage(browserReport));
  }
  throw new Error(pendingAuditRecoveryMessage());
}

function retryableBrowserSipMessage(
  report: Exclude<BrowserSipFinalResponse, { outcome: "accepted" }>,
) {
  if (report.outcome === "rejected") {
    return "Telefónna ústredňa hovor neprepojila. Stav je obnovený a hovor môžeš bezpečne skúsiť znova.";
  }
  return "Hovor sa skončil ešte pred spojením. Stav je obnovený a hovor môžeš bezpečne skúsiť znova.";
}

function unconfirmedBrowserSipMessage() {
  return new Error(
    "VIPTel zatiaľ nepotvrdil začiatok hovoru. Ak telefón ešte zvoní alebo je spojený, pokračuj v ňom; nový hovor zatiaľ nevytáčaj.",
  );
}

function pendingAuditRecoveryMessage() {
  return "Stav hovoru sa ešte bezpečne uzatvára. Hovor zatiaľ neopakuj; približne o dve minúty ho môžeš skúsiť znova.";
}

function delay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Kontrola telefónneho príkazu bola zrušená."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Kontrola telefónneho príkazu bola zrušená."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
