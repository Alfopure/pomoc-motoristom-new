import { notificationTarget } from "./notification-target";

type NotificationMessage = { type?: unknown; url?: unknown; requestId?: unknown };
type ReceiptPort = { postMessage: (message: unknown) => void };

type NotificationNavigationOptions = {
  origin: string;
  /** Identity of the authenticated console that installed this receiver. */
  sessionKey: string;
  currentSessionKey: () => string | null;
  open: (url: string) => void;
  acknowledge: (requestId: string) => void;
};

/** Receipt is synchronous and precedes the existing save/discard navigation guard.
 * The worker never needs to wait for a user's choice. No target is persisted or
 * replayed on login/session changes; a new tap is needed after a rejected receipt.
 */
export function createNotificationNavigationReceiver(options: NotificationNavigationOptions) {
  const received = new Set<string>();
  return (data: NotificationMessage | null | undefined, port?: ReceiptPort): boolean => {
    if (data?.type !== "PM_OPEN_NOTIFICATION" && data?.type !== "PM_OPEN_CALL_NOTIFICATION") return false;
    if (!options.sessionKey || options.currentSessionKey() !== options.sessionKey) return false;
    const target = notificationTarget(data.url, options.origin);
    if (!target || typeof data.url !== "string") return false;
    if ((data.type === "PM_OPEN_CALL_NOTIFICATION") !== (target.kind === "call")) return false;
    const requestId = typeof data.requestId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(data.requestId) ? data.requestId : null;
    const duplicate = requestId !== null && received.has(requestId);
    if (requestId) {
      received.add(requestId);
      // Keep only receipt IDs, never task content; bound memory per document.
      if (received.size > 100) received.delete(received.values().next().value!);
    }
    // A detached/expired MessagePort must not prevent receipt or the guard.
    try { port?.postMessage({ handled: true }); } catch { /* Worker deadline passed. */ }
    if (requestId) {
      try { options.acknowledge(requestId); } catch { /* A later explicit retry is deduplicated. */ }
    }
    if (!duplicate) options.open(data.url);
    return true;
  };
}
