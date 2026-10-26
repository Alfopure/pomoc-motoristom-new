const EVENT = 'motorist:open-case';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Navigation intent only. The server still authorizes the requested case. */
export function requestSharedCaseOpen(caseId: string) {
  if (UUID.test(caseId)) window.dispatchEvent(new CustomEvent(EVENT, { detail: caseId }));
}

export function subscribeSharedCaseOpen(open: (id: string, writeHistory: boolean) => void) {
  const onIntent = (event: Event) => {
    const id: unknown = (event as CustomEvent).detail;
    if (typeof id === 'string' && UUID.test(id)) open(id, true);
  };
  const onLink = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('a') : null;
    if (!link || link.target && link.target !== '_self' || link.hasAttribute('download')) return;
    const url = new URL(link.href, window.location.href);
    const id = url.searchParams.get('case');
    if (url.origin !== window.location.origin || url.pathname !== '/' || !id || !UUID.test(id)) return;
    event.preventDefault(); open(id, true);
  };
  const onHistory = () => {
    const id = new URL(window.location.href).searchParams.get('case');
    if (id && UUID.test(id)) open(id, false);
  };
  window.addEventListener(EVENT, onIntent);
  window.addEventListener('popstate', onHistory);
  document.addEventListener('click', onLink);
  return () => {
    window.removeEventListener(EVENT, onIntent);
    window.removeEventListener('popstate', onHistory);
    document.removeEventListener('click', onLink);
  };
}
