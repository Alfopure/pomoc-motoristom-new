/** Fake SDK for the isolated real-hook browser suite; never opens a socket. */
export class TelnyxRTC {
  remoteElement: unknown;
  private callbacks = new Map<string, (payload?: unknown) => void>();
  on(event: string, callback: (payload?: unknown) => void) { this.callbacks.set(event, callback); }
  off(event: string) { this.callbacks.delete(event); }
  async connect() {
    window.dispatchEvent(new CustomEvent("fixture-sdk-connected", { detail: (event: string, payload: unknown) => this.callbacks.get(event)?.(payload) }));
    this.callbacks.get("telnyx.ready")?.();
  }
  async disconnect() { this.callbacks.clear(); }
}
