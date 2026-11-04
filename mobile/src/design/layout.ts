/** Use the measured inner width: text growth trades columns for readable space. */
export function columnsForWidth(width: number, fontScale: number, minItemWidth: number, maxColumns: number, gap = 8): number {
  return Math.max(1, Math.min(maxColumns, Math.floor((width + gap) / (minItemWidth * Math.max(1, fontScale) + gap))));
}

export function gridItemWidth(width: number, columns: number, gap = 8): number {
  return Math.max(0, (width - gap * (columns - 1)) / columns);
}
