"use client";

import { useCallback, useSyncExternalStore } from "react";
import { EMPTY_CALLBACK_QUEUE, type CallbackQueuePayload } from "./callback-queue";
import { telephonyJson, TELEPHONY_TIMEOUT_MS } from "./client-request";
import { subscribeTelephonyRealtime } from "./realtime-client";

export type CallbackQueueSnapshot = { queue: CallbackQueuePayload; loaded: boolean; loading: boolean; error: string | null };
const EMPTY: CallbackQueueSnapshot = { queue: EMPTY_CALLBACK_QUEUE, loaded: false, loading: false, error: null };
type Listener = () => void;

/** At most one doorbell-triggered queue reload per this many ms (see `onDoorbell`). */
export const CALLBACK_DOORBELL_MIN_GAP_MS = 10_000;
/** A hidden console reloads the queue this rarely; showing the tab reloads at once. */
export const CALLBACK_HIDDEN_POLL_MS = 120_000;
function documentHidden() { return typeof document !== "undefined" && document.visibilityState === "hidden"; }

/** One authorized queue and polling chain shared by the header and panel. */
export class CallbackQueueStore {
  private snapshot: CallbackQueueSnapshot = EMPTY;
  private listeners = new Set<Listener>();
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lease: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeRealtime: (() => void) | null = null;
  private doorbellTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDoorbellReload = 0;
  private generation = 0;
  private failures = 0;
  private reloadRequested = false;
  constructor(private organizationId?: string) {}
  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => EMPTY;
  private publish(next: CallbackQueueSnapshot) { this.snapshot = next; this.listeners.forEach((listener) => listener()); }
  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      void this.load();
      if (typeof window !== "undefined") {
        window.addEventListener("focus", this.refresh);
        window.addEventListener("online", this.refresh);
        document.addEventListener("visibilitychange", this.onVisible);
        if (this.organizationId) {
          try { this.unsubscribeRealtime = subscribeTelephonyRealtime({ organizationId: this.organizationId, onChange: this.onDoorbell }); }
          catch { /* The authorized poll remains available without a realtime client. */ }
        }
      }
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      this.generation += 1;
      this.controller?.abort(); this.controller = null;
      if (this.timer) clearTimeout(this.timer);
      if (this.lease) clearTimeout(this.lease);
      if (this.doorbellTimer) { clearTimeout(this.doorbellTimer); this.doorbellTimer = null; }
      this.unsubscribeRealtime?.(); this.unsubscribeRealtime = null;
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", this.refresh);
        window.removeEventListener("online", this.refresh);
        document.removeEventListener("visibilitychange", this.onVisible);
      }
      this.snapshot = EMPTY;
    };
  };
  private onVisible = () => { if (document.visibilityState === "visible") this.refresh(); };
  /**
   * The telephony doorbell rings on every call-leg, session and presence write:
   * dozens of times per call in every open tab, while the queue itself changes
   * only when a callback is created or claimed. On 25 Sep these reloads were
   * ~73 % of all `callbacks` traffic. A doorbell now reloads the queue at most
   * once per `CALLBACK_DOORBELL_MIN_GAP_MS` (trailing, so the last change is
   * still picked up); the regular poll and the operator's own actions remain.
   */
  private onDoorbell = () => {
    if (!this.listeners.size || this.doorbellTimer) return;
    const wait = this.lastDoorbellReload + CALLBACK_DOORBELL_MIN_GAP_MS - Date.now();
    if (wait <= 0) { this.lastDoorbellReload = Date.now(); this.refresh(); return; }
    this.doorbellTimer = setTimeout(() => { this.doorbellTimer = null; this.lastDoorbellReload = Date.now(); this.refresh(); }, wait);
  };
  refresh = () => {
    if (!this.listeners.size) return;
    if (this.controller) { this.reloadRequested = true; return; }
    // Coalesce bursts from call legs, sessions and queue mutations.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.load(), 150);
  };
  loadMore = () => { if (this.snapshot.queue.nextCursor && !this.controller) void this.load(this.snapshot.queue.nextCursor); };
  private async load(cursor?: string) {
    if (!this.listeners.size || this.controller) return;
    if (this.timer) clearTimeout(this.timer);
    const startedAt = Date.now();
    const controller = new AbortController(); this.controller = controller;
    const generation = ++this.generation;
    this.publish({ ...this.snapshot, loading: true });
    try {
      const targetCount = cursor ? 0 : this.snapshot.queue.open.length;
      let pageCursor = cursor;
      let queue: CallbackQueuePayload = EMPTY_CALLBACK_QUEUE;
      const seenCursors = new Set<string>();
      do {
        const result = await telephonyJson<CallbackQueuePayload & { error?: string }>(`/api/telephony/callbacks${pageCursor ? `?cursor=${encodeURIComponent(pageCursor)}` : ""}`, {
          label: "fronta spätných volaní", signal: controller.signal, timeoutMs: TELEPHONY_TIMEOUT_MS.read,
        });
        if (generation !== this.generation) return;
        if (!result.ok || !result.body) {
          if (result.status === 401 || result.status === 403) this.publish({ ...EMPTY, loaded: true, error: "Prístup k spätným volaniam už nie je dostupný." });
          throw new Error(result.body?.error ?? "Frontu spätných volaní sa nepodarilo načítať.");
        }
        const page = result.body;
        queue = { ...page, open: [...new Map([...queue.open, ...page.open].map((row) => [row.id, row])).values()] };
        pageCursor = page.nextCursor ?? undefined;
        if (pageCursor && seenCursors.has(pageCursor)) throw new Error("Stránkovanie fronty sa nepodarilo dokončiť.");
        if (pageCursor) seenCursors.add(pageCursor);
      } while (!cursor && pageCursor && queue.open.length < targetCount);
      this.failures = 0;
      if (cursor) queue.open = [...new Map([...this.snapshot.queue.open, ...queue.open].map((row) => [row.id, row])).values()];
      this.publish({ queue, loaded: true, loading: false, error: null });
      if (this.lease) clearTimeout(this.lease);
      // Never retain private caller data indefinitely through a failed reauth.
      this.lease = setTimeout(() => {
        this.generation += 1; this.controller?.abort(); this.controller = null;
        this.publish({ ...EMPTY, loaded: true, error: "Spojenie sa overuje. Fronta sa zobrazí po obnovení prístupu." });
        // A hidden tab reloads when it is shown again (`onVisible`), not every 30 s.
        if (!documentHidden()) this.refresh();
      }, Math.max(0, 30_000 - (Date.now() - startedAt)));
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) return;
      this.failures += 1;
      this.publish({ ...this.snapshot, loaded: true, loading: false, error: error instanceof Error ? error.message : "Frontu sa nepodarilo načítať." });
    } finally {
      if (generation === this.generation) this.controller = null;
      if (this.listeners.size && generation === this.generation) {
        const delay = this.reloadRequested ? 150 : documentHidden() ? CALLBACK_HIDDEN_POLL_MS : Math.min(25_000 * 2 ** this.failures, 120_000);
        this.reloadRequested = false;
        this.timer = setTimeout(() => void this.load(), delay);
      }
    }
  }
}

const stores = new Map<string, CallbackQueueStore>();
function storeFor(scopeKey: string, organizationId?: string) {
  const key = `${scopeKey}:${organizationId ?? ""}`;
  let store = stores.get(key);
  if (!store) { store = new CallbackQueueStore(organizationId); stores.set(key, store); }
  return store;
}
export function invalidateCallbackQueue(scopeKey: string, organizationId?: string) { storeFor(scopeKey, organizationId).refresh(); }
export function useCallbackQueue(scopeKey: string, organizationId?: string) {
  const store = storeFor(scopeKey, organizationId);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const reload = useCallback(() => store.refresh(), [store]);
  return { ...state, reload, loadMore: store.loadMore };
}
