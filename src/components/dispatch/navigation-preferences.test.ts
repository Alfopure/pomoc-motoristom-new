import { describe, expect, it } from "vitest";

import {
  DEFAULT_PINNED_NAVIGATION_VIEWS,
  DEFAULT_MOBILE_NAVIGATION_SHORTCUTS,
  MAX_PINNED_NAVIGATION_VIEWS,
  MAX_MOBILE_NAVIGATION_SHORTCUTS,
  mobileNavigationPreferenceStorageKey,
  navigationPreferenceStorageKey,
  parseMobileNavigationShortcuts,
  parsePinnedNavigationViews,
  toggleMobileNavigationShortcut,
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
    expect(mobileNavigationPreferenceStorageKey("profile-1")).toBe("motorist:mobile-navigation:v1:profile-1");
  });

  it("keeps the existing cases, tasks, and map mobile defaults", () => {
    expect(parseMobileNavigationShortcuts(null)).toEqual(DEFAULT_MOBILE_NAVIGATION_SHORTCUTS);
    expect(DEFAULT_MOBILE_NAVIGATION_SHORTCUTS).toHaveLength(MAX_MOBILE_NAVIGATION_SHORTCUTS);
  });

  it("drops malformed, duplicate, unsupported, and unavailable mobile shortcuts", () => {
    expect(parseMobileNavigationShortcuts("not-json")).toEqual(DEFAULT_MOBILE_NAVIGATION_SHORTCUTS);
    expect(parseMobileNavigationShortcuts(JSON.stringify(["fleet", "fleet", "unknown", "settings", "tasks", "reports"]))).toEqual([
      "fleet",
      "settings",
      "tasks",
    ]);
    expect(parseMobileNavigationShortcuts(JSON.stringify(["settings", "tasks", "dispatch-map"]), ["tasks", "dispatch-map"])).toEqual([
      "tasks",
      "dispatch-map",
    ]);
  });

  it("edits mobile shortcuts explicitly without replacing another slot", () => {
    expect(toggleMobileNavigationShortcut(["tasks", "dispatch-map"], "fleet")).toEqual({
      limitReached: false,
      shortcuts: ["tasks", "dispatch-map", "fleet"],
    });
    expect(toggleMobileNavigationShortcut(["tasks", "dispatch-map", "fleet"], "settings")).toEqual({
      limitReached: true,
      shortcuts: ["tasks", "dispatch-map", "fleet"],
    });
    expect(toggleMobileNavigationShortcut(["tasks", "dispatch-map", "fleet"], "tasks")).toEqual({
      limitReached: false,
      shortcuts: ["dispatch-map", "fleet"],
    });
  });
});
