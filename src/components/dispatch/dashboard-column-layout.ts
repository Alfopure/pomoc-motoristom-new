export type DashboardColumnSide = "left" | "right";

export type DashboardColumnWidths = {
  left: number;
  right: number;
};

export const DEFAULT_DASHBOARD_COLUMNS: DashboardColumnWidths = { left: 330, right: 330 };
export const DASHBOARD_LEFT_MIN = 260;
export const DASHBOARD_LEFT_MAX = 480;
export const DASHBOARD_RIGHT_MIN = 280;
export const DASHBOARD_RIGHT_MAX = 480;
const DASHBOARD_CENTER_MIN = 480;


function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

export function fitDashboardColumns(columns: DashboardColumnWidths, gridWidth: number, rightVisible: boolean): DashboardColumnWidths {
  let left = clampNumber(columns.left, DASHBOARD_LEFT_MIN, DASHBOARD_LEFT_MAX, DEFAULT_DASHBOARD_COLUMNS.left);
  let right = clampNumber(columns.right, DASHBOARD_RIGHT_MIN, DASHBOARD_RIGHT_MAX, DEFAULT_DASHBOARD_COLUMNS.right);

  if (!rightVisible) {
    left = Math.min(left, Math.max(DASHBOARD_LEFT_MIN, gridWidth - DASHBOARD_CENTER_MIN));
    return { left, right };
  }

  const availableForRails = Math.max(
    DASHBOARD_LEFT_MIN + DASHBOARD_RIGHT_MIN,
    gridWidth - DASHBOARD_CENTER_MIN,
  );
  let overflow = Math.max(0, left + right - availableForRails);
  const rightReduction = Math.min(overflow, right - DASHBOARD_RIGHT_MIN);
  right -= rightReduction;
  overflow -= rightReduction;
  left -= Math.min(overflow, left - DASHBOARD_LEFT_MIN);

  return { left, right };
}

export function resizeDashboardColumn(
  columns: DashboardColumnWidths,
  side: DashboardColumnSide,
  requestedWidth: number,
  gridWidth: number,
  rightVisible: boolean,
): DashboardColumnWidths {
  const fitted = fitDashboardColumns(columns, gridWidth, rightVisible);
  const minimum = side === "left" ? DASHBOARD_LEFT_MIN : DASHBOARD_RIGHT_MIN;
  const hardMaximum = side === "left" ? DASHBOARD_LEFT_MAX : DASHBOARD_RIGHT_MAX;
  const otherWidth = side === "left" ? (rightVisible ? fitted.right : 0) : fitted.left;
  const viewportMaximum = Math.max(minimum, gridWidth - DASHBOARD_CENTER_MIN - otherWidth);
  const width = clampNumber(requestedWidth, minimum, Math.min(hardMaximum, viewportMaximum), fitted[side]);

  // Save only the rail the user resized; the other rail may be temporarily fitted.
  return { ...columns, [side]: width };
}


export function parseDashboardColumnWidths(raw: string | null): DashboardColumnWidths {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_DASHBOARD_COLUMNS };
    const columns = value as Partial<DashboardColumnWidths>;
    return {
      left: clampNumber(columns.left, DASHBOARD_LEFT_MIN, DASHBOARD_LEFT_MAX, DEFAULT_DASHBOARD_COLUMNS.left),
      right: clampNumber(columns.right, DASHBOARD_RIGHT_MIN, DASHBOARD_RIGHT_MAX, DEFAULT_DASHBOARD_COLUMNS.right),
    };
  } catch { return { ...DEFAULT_DASHBOARD_COLUMNS }; }
}
