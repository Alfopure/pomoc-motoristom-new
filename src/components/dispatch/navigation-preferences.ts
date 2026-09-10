export const MAX_PINNED_NAVIGATION_VIEWS = 3;

export const PINNABLE_NAVIGATION_VIEWS = [
  "tasks",
  "notes",
  "tools",
  "cases",
  "call-center",
  "attendance",
  "fleet",
  "reports",
  "settings",
] as const;

export type PinnableNavigationView = (typeof PINNABLE_NAVIGATION_VIEWS)[number];

export const DEFAULT_PINNED_NAVIGATION_VIEWS: PinnableNavigationView[] = ["tasks", "cases"];

export const MAX_MOBILE_NAVIGATION_SHORTCUTS = 3;

export const MOBILE_NAVIGATION_SHORTCUTS = [
  "dispatch-cases",
  "tasks",
  "notes",
  "tools",
  "dispatch-map",
  "call-center",
  "attendance",
  "fleet",
  "reports",
  "settings",
] as const;

export type MobileNavigationShortcut = (typeof MOBILE_NAVIGATION_SHORTCUTS)[number];

/** Preserves the existing mobile footer for profiles without a preference. */
export const DEFAULT_MOBILE_NAVIGATION_SHORTCUTS: MobileNavigationShortcut[] = ["dispatch-cases", "tasks", "dispatch-map"];

const pinnableNavigationViews = new Set<string>(PINNABLE_NAVIGATION_VIEWS);

export function isPinnableNavigationView(value: unknown): value is PinnableNavigationView {
  return typeof value === "string" && pinnableNavigationViews.has(value);
}

export function navigationPreferenceStorageKey(profileId?: string): string {
  return `motorist:navigation-pins:v1:${profileId ?? "local-browser"}`;
}

export function mobileNavigationPreferenceStorageKey(profileId?: string): string {
  return `motorist:mobile-navigation:v1:${profileId ?? "local-browser"}`;
}

export function parsePinnedNavigationViews(raw: string | null): PinnableNavigationView[] {
  if (raw === null) return [...DEFAULT_PINNED_NAVIGATION_VIEWS];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_PINNED_NAVIGATION_VIEWS];

    return [...new Set(parsed.filter(isPinnableNavigationView))].slice(0, MAX_PINNED_NAVIGATION_VIEWS);
  } catch {
    return [...DEFAULT_PINNED_NAVIGATION_VIEWS];
  }
}

export function togglePinnedNavigationView(
  current: readonly PinnableNavigationView[],
  view: PinnableNavigationView,
): { limitReached: boolean; views: PinnableNavigationView[] } {
  if (current.includes(view)) {
    return { limitReached: false, views: current.filter((candidate) => candidate !== view) };
  }

  if (current.length >= MAX_PINNED_NAVIGATION_VIEWS) {
    return { limitReached: true, views: [...current] };
  }

  return { limitReached: false, views: [...current, view] };
}

const mobileNavigationShortcuts = new Set<string>(MOBILE_NAVIGATION_SHORTCUTS);

export function isMobileNavigationShortcut(value: unknown): value is MobileNavigationShortcut {
  return typeof value === "string" && mobileNavigationShortcuts.has(value);
}

/**
 * Parses only shortcuts available to the current profile. Callers can derive
 * `available` from the navigation items they are permitted to render, so stale
 * local preferences cannot restore a hidden screen.
 */
export function parseMobileNavigationShortcuts(
  raw: string | null,
  available: readonly MobileNavigationShortcut[] = MOBILE_NAVIGATION_SHORTCUTS,
): MobileNavigationShortcut[] {
  const allowed = new Set(available);
  const defaults = DEFAULT_MOBILE_NAVIGATION_SHORTCUTS.filter((shortcut) => allowed.has(shortcut));
  if (raw === null) return defaults;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaults;
    return [...new Set(parsed.filter(isMobileNavigationShortcut))]
      .filter((shortcut) => allowed.has(shortcut))
      .slice(0, MAX_MOBILE_NAVIGATION_SHORTCUTS);
  } catch {
    return defaults;
  }
}

export function toggleMobileNavigationShortcut(
  current: readonly MobileNavigationShortcut[],
  shortcut: MobileNavigationShortcut,
): { limitReached: boolean; shortcuts: MobileNavigationShortcut[] } {
  if (current.includes(shortcut)) {
    return { limitReached: false, shortcuts: current.filter((candidate) => candidate !== shortcut) };
  }
  if (current.length >= MAX_MOBILE_NAVIGATION_SHORTCUTS) {
    return { limitReached: true, shortcuts: [...current] };
  }
  return { limitReached: false, shortcuts: [...current, shortcut] };
}
