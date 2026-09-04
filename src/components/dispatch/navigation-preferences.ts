export const MAX_PINNED_NAVIGATION_VIEWS = 3;

export const PINNABLE_NAVIGATION_VIEWS = [
  "tasks",
  "cases",
  "call-center",
  "attendance",
  "fleet",
  "reports",
  "settings",
] as const;

export type PinnableNavigationView = (typeof PINNABLE_NAVIGATION_VIEWS)[number];

export const DEFAULT_PINNED_NAVIGATION_VIEWS: PinnableNavigationView[] = ["tasks", "cases"];

const pinnableNavigationViews = new Set<string>(PINNABLE_NAVIGATION_VIEWS);

export function isPinnableNavigationView(value: unknown): value is PinnableNavigationView {
  return typeof value === "string" && pinnableNavigationViews.has(value);
}

export function navigationPreferenceStorageKey(profileId?: string): string {
  return `motorist:navigation-pins:v1:${profileId ?? "local-browser"}`;
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
