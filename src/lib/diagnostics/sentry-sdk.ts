import { BrowserClient, makeFetchTransport } from '@sentry/browser';
import type { SafeException } from './sentry';

export function createPrivateSentryClient(dsn: string) {
  const client = new BrowserClient({
    dsn,
    integrations: [],
    stackParser: () => [],
    transport: makeFetchTransport,
    sendDefaultPii: false,
    sendClientReports: false,
    maxBreadcrumbs: 0,
    enableLogs: false,
    tracePropagationTargets: [],
    transportOptions: { fetchOptions: { referrerPolicy: 'no-referrer' } },
    beforeSend: event => {
      // Reconstruct at the outbound boundary; discard any SDK context additions.
      const original = event as unknown as SafeException;
      return {
        type: undefined,
        event_id: original.event_id,
        level: 'error',
        platform: 'javascript',
        release: original.release,
        exception: original.exception,
        tags: { diagnostic_error_id: original.event_id },
      };
    },
  });
  client.init();
  return client;
}
