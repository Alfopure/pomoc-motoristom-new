const mapParameters = new Set(["q", "ll", "z", "t", "hl", "ie", "mapclient", "layer"]);
export function attributionUrl(value: string): string | null {
  if (value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
    const map = ["www.google.com", "maps.google.com"].includes(url.hostname) && ["/maps", "/maps/"].includes(url.pathname);
    const terms = url.hostname === "www.google.com" && /^\/intl\/[a-zA-Z-]{2,12}\/help\/terms_maps\.html$/.test(url.pathname);
    const policy = url.hostname === "policies.google.com" && ["/privacy", "/terms"].includes(url.pathname);
    if (!map && !terms && !policy) return null;
    for (const [key, v] of url.searchParams) if (!(map ? mapParameters.has(key) : key === "hl" && /^[a-zA-Z-]{2,12}$/.test(v))) return null;
    return url.href;
  } catch { return null; }
}
/** No external navigation occurs until the user's confirmation in the same live scope. */
export function confirmAttribution(value: string, actions: { current: () => boolean; confirm: (proceed: () => void) => void; open: (url: string) => Promise<unknown>; failed: () => void }) {
  const url = attributionUrl(value);
  if (!url || !actions.current()) return false;
  actions.confirm(() => {
    if (!actions.current()) return;
    void actions.open(url).catch(() => { if (actions.current()) actions.failed(); });
  });
  return true;
}
