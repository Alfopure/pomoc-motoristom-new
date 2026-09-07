/** Installation + mobile platform, never viewport width or push-provider host. */
export function isMobileApp(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const installed = window.matchMedia?.("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  return Boolean(installed && mobile);
}
