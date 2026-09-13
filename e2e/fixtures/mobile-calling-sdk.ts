/** Fake SDK for the isolated real-hook browser suite; never opens a socket. */
export class TelnyxRTC {
  remoteElement: unknown;
  readonly connection = { connected: false };
  private callbacks = new Map<string, (payload?: unknown) => void>();
  constructor(public options: { login_token?: string } = {}) {
    window.dispatchEvent(new CustomEvent("fixture-sdk-created", { detail: options }));
  }
  on(event: string, callback: (payload?: unknown) => void) { this.callbacks.set(event, callback); }
  off(event: string) { this.callbacks.delete(event); }
  async connect() {
    this.connection.connected = true;
    window.dispatchEvent(new CustomEvent("fixture-sdk-connected", { detail: (event: string, payload: unknown) => {
      if (event === "telnyx.socket.close") this.connection.connected = false;
      if (event === "telnyx.socket.open" || event === "telnyx.ready") this.connection.connected = true;
      this.callbacks.get(event)?.(payload);
    } }));
    this.callbacks.get("telnyx.ready")?.();
  }
  login(input?: { creds?: { login_token?: string }; onSuccess?: () => void; onError?: (error: unknown) => void }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const event = new CustomEvent("fixture-sdk-login", { cancelable: true, detail: {
        token: input?.creds?.login_token,
        resolve: () => { this.options.login_token = input?.creds?.login_token; input?.onSuccess?.(); resolve(); },
        reject: (error: unknown) => { input?.onError?.(error); reject(error); },
      } });
      if (window.dispatchEvent(event)) event.detail.resolve();
    });
  }
  async disconnect() {
    this.connection.connected = false;
    this.callbacks.clear();
    window.dispatchEvent(new Event("fixture-sdk-disconnected"));
  }
}
