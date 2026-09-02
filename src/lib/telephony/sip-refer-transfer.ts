export type SipReferResponse = {
  message: { statusCode?: number };
};

export type SipReferNotification = {
  accept(): Promise<void>;
  request: {
    body?: string;
    getHeader?(name: string): string | undefined;
  };
};

export type SipReferSession = {
  refer(
    target: object,
    options: {
      onNotify(notification: SipReferNotification): void;
      requestDelegate: {
        onAccept(response: SipReferResponse): void;
        onRedirect(response: SipReferResponse): void;
        onReject(response: SipReferResponse): void;
      };
    },
  ): Promise<unknown>;
};

export type SipReferAcceptance = {
  accepted: true;
  statusCode: number;
};

/**
 * Sends one blind SIP REFER and waits for the PBX's final refer NOTIFY.
 * Resolving the SIP.js request only means that REFER was written to the socket
 * and a 202 only accepts the transfer request; neither proves that the remote
 * party was actually transferred.
 */
export function sendSipReferAndAwaitAcceptance(
  session: SipReferSession,
  target: object,
  options: {
    timeoutMs?: number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
  } = {},
): Promise<SipReferAcceptance> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      callback();
    };
    const rejected = (response: SipReferResponse) => {
      const status = response.message.statusCode;
      finish(() => reject(new Error(
        status ? `VIPTel odmietol SIP prepojenie (SIP ${status}).` : "VIPTel odmietol SIP prepojenie.",
      )));
    };
    const timer = setTimer(() => finish(() => reject(new Error(
      "VIPTel nepotvrdil SIP prepojenie v bezpečnom časovom limite.",
    ))), timeoutMs);

    session.refer(target, {
      onNotify(notification) {
        void notification.accept().catch(() => undefined);
        const status = sipFragStatus(notification.request.body);
        if (status === undefined || status < 200) return;
        if (status < 300) {
          finish(() => resolve({ accepted: true, statusCode: status }));
          return;
        }
        finish(() => reject(new Error(`VIPTel nedokončil SIP prepojenie (SIP ${status}).`)));
      },
      requestDelegate: {
        // A 2xx response confirms only receipt of REFER. The final outcome is
        // delivered separately as message/sipfrag in a refer NOTIFY.
        onAccept() {},
        onRedirect: rejected,
        onReject: rejected,
      },
    }).catch((error) => finish(() => reject(
      error instanceof Error ? error : new Error("SIP prepojenie sa nepodarilo odoslať."),
    )));
  });
}

export function sipFragStatus(body: string | undefined) {
  if (!body) return undefined;
  const match = body.match(/(?:^|\r?\n)\s*SIP\/2\.0\s+(\d{3})(?:\s|$)/i);
  if (!match) return undefined;
  const status = Number(match[1]);
  return Number.isInteger(status) && status >= 100 && status <= 699 ? status : undefined;
}
