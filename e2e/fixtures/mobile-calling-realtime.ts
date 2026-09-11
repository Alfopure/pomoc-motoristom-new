// The phone fixture is isolated from real account data and realtime sockets.
export function subscribeTelephonyRealtime(input: { onStatus?: (status: "connected" | "disconnected") => void; onChange: () => void }) {
  const status = (event: Event) => input.onStatus?.((event as CustomEvent<"connected" | "disconnected">).detail);
  const change = () => input.onChange();
  window.addEventListener("fixture-realtime-status", status);
  window.addEventListener("fixture-realtime-change", change);
  return () => {
    window.removeEventListener("fixture-realtime-status", status);
    window.removeEventListener("fixture-realtime-change", change);
  };
}
