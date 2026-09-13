/** The released workspace is available on both Vercel targets; appearance remains actor-specific. */
export function layoutPreviewEnabled(env: { VERCEL_ENV?: string; NODE_ENV?: string }) {
  return env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview" || env.NODE_ENV === "development";
}

export type LayoutPreviewMode = "modern" | "classic";
export function parseLayoutPreviewMode(raw: string | null): LayoutPreviewMode {
  return raw === "classic" ? "classic" : "modern";
}

export function layoutPreviewStorageKey(actorKey: string) {
  return `motorist:layout-preview:v1:${actorKey}`;
}
