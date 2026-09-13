export const WIDGET_IDS = ["phone", "tasks", "notes", "calculator", "route", "search", "fleet", "calendar"] as const;
export type WidgetId = (typeof WIDGET_IDS)[number];
export type WorkspaceCenterView = "map" | "table" | "tasks" | "notes";
export type WidgetPreference = { id: WidgetId; visible: boolean; collapsed: boolean };
export type WorkspacePreferences = {
  widgets: WidgetPreference[];
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  centerView: WorkspaceCenterView;
};

export const WIDGET_LABELS: Record<WidgetId, string> = {
  phone: "Rýchle volanie", tasks: "Úlohy", notes: "Poznámky", calculator: "Kalkulačka",
  route: "Plánovač trasy", search: "Vyhľadávanie", fleet: "Flotila", calendar: "Kalendár",
};

export function workspacePreferenceStorageKey(organizationId?: string, profileId?: string) {
  return `motorist:workspace:v3:${organizationId ?? "demo"}:${profileId ?? "local-browser"}`;
}

export function defaultWorkspacePreferences(): WorkspacePreferences {
  return {
    widgets: WIDGET_IDS.map(id => ({ id, visible: id === "phone" || id === "tasks", collapsed: false })),
    leftCollapsed: false, rightCollapsed: false, centerView: "map",
  };
}

export function parseWorkspacePreferences(raw: string | null): WorkspacePreferences {
  const defaults = defaultWorkspacePreferences();
  try {
    const data: unknown = raw ? JSON.parse(raw) : null;
    if (!data || typeof data !== "object" || Array.isArray(data)) return defaults;
    const value = data as Record<string, unknown>;
    const seen = new Set<WidgetId>();
    const widgets: WidgetPreference[] = [];
    if (Array.isArray(value.widgets)) for (const item of value.widgets) {
      if (!item || typeof item !== "object" || !WIDGET_IDS.includes(item.id) || seen.has(item.id)) continue;
      seen.add(item.id);
      widgets.push({ id: item.id, visible: item.visible === true, collapsed: item.collapsed === true });
    }
    widgets.push(...defaults.widgets.filter(item => !seen.has(item.id)));
    return {
      widgets,
      leftCollapsed: value.leftCollapsed === true,
      rightCollapsed: value.rightCollapsed === true,
      centerView: ["map", "table", "tasks", "notes"].includes(String(value.centerView))
        ? value.centerView as WorkspaceCenterView : "map",
    };
  } catch { return defaults; }
}

export function moveWidget(widgets: WidgetPreference[], id: WidgetId, destination: number): WidgetPreference[] {
  const index = widgets.findIndex(item => item.id === id);
  if (index < 0 || destination < 0 || destination >= widgets.length || index === destination) return widgets;
  const result = [...widgets];
  result.splice(destination, 0, ...result.splice(index, 1));
  return result;
}
