import { BrowserClient, makeFetchTransport } from '@sentry/browser';
import { sanitizeOutboundDiagnosticException } from './sentry';

export function createPrivateSentryClient(dsn: string) {
  const client = new BrowserClient({
    dsn,
    integrations: [],
    stackParser: () => [],
    transport: makeFetchTransport,
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
