import { BrowserClient, makeFetchTransport } from '@sentry/browser';
import { sanitizeOutboundDiagnosticException } from './sentry';
import type { SafeException } from './sentry';
import type { DiagnosticExceptionResponse } from './exception-queue';

export function createPrivateSentryClient(dsn: string) {
  const client = new BrowserClient({
    dsn,
    integrations: [],
    stackParser: () => [],
    transport: options => makeFetchTransport({ ...options, bufferSize: 2 }, async (url, init) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try { return await fetch(url, { ...init, signal: controller.signal, credentials: 'omit' }); }
      finally { clearTimeout(timeout); }
    }),
    sendDefaultPii: false,
    sendClientReports: false,
    maxBreadcrumbs: 12,
    enableLogs: false,
    tracePropagationTargets: [],
    transportOptions: { fetchOptions: { referrerPolicy: 'no-referrer' } },
    beforeSend: event => {
      // Reconstruct at the outbound boundary; discard any SDK context additions.
      return sanitizeOutboundDiagnosticException(event, typeof location === 'undefined' ? '' : location.origin);
    },
  });
  client.init();
  return client;
}

/** SDK buffer drain alone is not a server ACK (it also drains after HTTP 503). */
export function sendPrivateSentryEvent(client: BrowserClient, event: SafeException): Promise<DiagnosticExceptionResponse> {
  return new Promise(resolve => {
    const finish = (response: DiagnosticExceptionResponse) => { clearTimeout(timeout); unsubscribe(); resolve(response); };
    const unsubscribe = client.on('afterSendEvent', (sent, response) => {
      if (sent.event_id === event.event_id) finish(response);
    });
    const timeout = setTimeout(() => finish({}), 10000);
    try { client.captureEvent(event); } catch { finish({}); }
  });
}
