export type PushTarget = { kind: "task"; id: string } | { kind: "case"; id: string } | { kind: "callbacks" };
type PushTap = { key: string; profileId: string; target: PushTarget };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Where a tapped notification leads; anything unexpected opens only the app. */
export function readPushTap(response: unknown): PushTap | null {
  const request = (response as { notification?: { request?: { identifier?: unknown; content?: { data?: unknown } } } } | null)?.notification?.request;
  const data = request?.content?.data as Record<string, unknown> | null | undefined;
  if (!request || typeof request.identifier !== "string" || !data || typeof data !== "object") return null;
  if (typeof data.profileId !== "string" || !UUID.test(data.profileId)) return null;
  const profileId = data.profileId.toLowerCase();
  if (data.kind === "callbacks") return { key: request.identifier, profileId, target: { kind: "callbacks" } };
  if ((data.kind === "task" || data.kind === "case") && typeof data.id === "string" && UUID.test(data.id)) {
    return { key: request.identifier, profileId, target: { kind: data.kind, id: data.id.toLowerCase() } };
  }
  return null;
}

/** A tapped notification waits here until the signed-in workspace can open it,
 * e.g. after a cold start or a sign-in. Each tap opens once. */
export class PushTapInbox {
  private pending: PushTap | null = null;
  private handled = new Set<string>();
  private listeners = new Set<() => void>();
  snapshot = () => this.pending;
  subscribe = (notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; };
  receive(response: unknown) {
    const tap = readPushTap(response);
    if (!tap || this.handled.has(tap.key)) return;
    this.pending = tap;
    for (const notify of this.listeners) notify();
  }
  /** The target for this operator; a notice sent to another account only opens the app. */
  take(profileId: string): PushTarget | null {
    const tap = this.pending;
    if (!tap) return null;
    this.pending = null;
    this.handled.add(tap.key);
    for (const notify of this.listeners) notify();
    return tap.profileId === profileId.toLowerCase() ? tap.target : null;
  }
}

export const pushTaps = new PushTapInbox();
