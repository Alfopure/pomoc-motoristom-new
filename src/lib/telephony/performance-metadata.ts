/** Bounded provenance only; browser wall clocks never determine a duration. */
export function performanceBuild(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : undefined;
}

export function performanceTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) ? value : undefined;
}

export function browserPerformanceBuild(): string {
  return performanceBuild(process.env.NEXT_PUBLIC_DIAGNOSTICS_BUILD_ID) ?? "local";
}
