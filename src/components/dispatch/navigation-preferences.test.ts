import { describe, expect, it } from "vitest";

import {
  DEFAULT_PINNED_NAVIGATION_VIEWS,
  MAX_PINNED_NAVIGATION_VIEWS,
  navigationPreferenceStorageKey,
  parsePinnedNavigationViews,
  togglePinnedNavigationView,
} from "./navigation-preferences";

describe("navigation preferences", () => {
  it("uses practical defaults when no valid personal preference exists", () => {
    expect(parsePinnedNavigationViews(null)).toEqual(DEFAULT_PINNED_NAVIGATION_VIEWS);
    expect(parsePinnedNavigationViews("not-json")).toEqual(DEFAULT_PINNED_NAVIGATION_VIEWS);
    expect(parsePinnedNavigationViews(JSON.stringify({ tasks: true }))).toEqual(DEFAULT_PINNED_NAVIGATION_VIEWS);
  });

  it("keeps only unique supported views and respects the header limit", () => {
    expect(parsePinnedNavigationViews(JSON.stringify(["reports", "reports", "unknown", "fleet", "settings", "tasks"]))).toEqual([
      "reports",
      "fleet",
      "settings",
    ]);
  });

  it("preserves an intentionally empty set of shortcuts", () => {
    expect(parsePinnedNavigationViews("[]")).toEqual([]);
  });

  it("adds, removes, and caps shortcuts without silently replacing one", () => {
    expect(togglePinnedNavigationView(["tasks"], "cases")).toEqual({ limitReached: false, views: ["tasks", "cases"] });
    expect(togglePinnedNavigationView(["tasks", "cases"], "tasks")).toEqual({ limitReached: false, views: ["cases"] });

    const full = ["tasks", "cases", "call-center"] as const;
    expect(full).toHaveLength(MAX_PINNED_NAVIGATION_VIEWS);
    expect(togglePinnedNavigationView(full, "fleet")).toEqual({ limitReached: true, views: [...full] });
  });

  it("scopes preferences by signed-in profile", () => {
    expect(navigationPreferenceStorageKey("profile-1")).toBe("motorist:navigation-pins:v1:profile-1");
    expect(navigationPreferenceStorageKey()).toBe("motorist:navigation-pins:v1:local-browser");
  });
});
