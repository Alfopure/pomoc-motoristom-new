// Browser boundary only: real provider/store; no remote websocket or Supabase project.
type Callback = () => void;
const listeners = new Map<string, Set<Callback>>();
Object.assign(window, { collaborationBroadcast: () => { for (const handlers of listeners.values()) for (const handler of handlers) handler(); } });
export function createSupabaseBrowserClient() {
  return {
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    channel(topic: string) {
      const handlers = new Set<Callback>(); listeners.set(topic, handlers);
      const channel = { topic, on(_type: string, filter: { event: string }, callback: Callback) { if (filter.event === "invalidate") handlers.add(callback); return channel; },
        subscribe(callback: (status: string) => void) { queueMicrotask(() => callback("SUBSCRIBED")); return channel; } };
      return channel;
    },
    removeChannel(channel: { topic: string }) { listeners.delete(channel.topic); },
  };
}

// The fixture has no remote auth handshake; join after the current microtask.
export function afterRealtimeAuth(_client: object, join: () => void) {
  let cancelled = false;
  queueMicrotask(() => { if (!cancelled) join(); });
  return () => { cancelled = true; };
}
