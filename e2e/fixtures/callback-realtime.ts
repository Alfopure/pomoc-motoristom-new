/** Synthetic broadcast transport; the production queue store is unchanged. */
export function createSupabaseBrowserClient() {
  return {
    channel: () => {
      let listener: (() => void) | null = null;
      const channel = {
        on: (_type: string, _filter: unknown, callback: () => void) => { listener = callback; return channel; },
        subscribe: (callback?: (status: string) => void) => { if (listener) window.addEventListener("fixture-telephony-change", listener); queueMicrotask(() => callback?.("SUBSCRIBED")); return channel; },
        unsubscribe: async () => { if (listener) window.removeEventListener("fixture-telephony-change", listener); },
      };
      return channel;
    },
    removeChannel: (channel: { unsubscribe: () => Promise<void> }) => channel.unsubscribe(),
  };
}
