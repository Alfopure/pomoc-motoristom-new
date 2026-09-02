export type WorkplacePhoneRecoveryResult<T = unknown> =
  | { kind: "disconnected"; outcome: T }
  | { kind: "transition_cancelled"; message: string }
  | { kind: "continuity_blocked"; message: string };

type PendingPhoneTransition = {
  operationId?: string;
  phase: "prepare" | "finalize";
};

/**
 * A failed local SIP cleanup must never erase the durable server operation.
 * If the exact finalize operation is known, cancel it first. Otherwise keep
 * the journal so the same operation can be retried without stranding a lock.
 */
export async function disconnectOrCancelRecoveredPhoneTransition<T>(options: {
  cancelTransition: (operationId: string) => Promise<void>;
  disconnectPhone: () => Promise<T>;
  pending: PendingPhoneTransition;
}): Promise<WorkplacePhoneRecoveryResult<T>> {
  try {
    const outcome = await options.disconnectPhone();
    return { kind: "disconnected", outcome };
  } catch (disconnectError) {
    const disconnectMessage = errorMessage(
      disconnectError,
      "VIPTel nepotvrdil odpojenie telefónu.",
    );
    if (options.pending.phase !== "finalize" || !options.pending.operationId) {
      return {
        kind: "continuity_blocked",
        message: `${disconnectMessage} Presná rozpracovaná zmena zostala uložená.`,
      };
    }

    try {
      await options.cancelTransition(options.pending.operationId);
      return {
        kind: "transition_cancelled",
        message: `${disconnectMessage} Rozpracovaný presun bol bezpečne zrušený; pôvodné miesto zostalo pridelené.`,
      };
    } catch (cancelError) {
      return {
        kind: "continuity_blocked",
        message: `${disconnectMessage} Zrušenie rozpracovaného presunu sa nepotvrdilo (${errorMessage(
          cancelError,
          "neznáma chyba",
        )}); presná zmena zostala uložená.`,
      };
    }
  }
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message.trim() : fallback;
}
