/** Preview is a server decision; neither URL nor browser storage can enable it in production. */
export function layoutPreviewEnabled(env: { VERCEL_ENV?: string; NODE_ENV?: string }) {
  if (env.VERCEL_ENV === "production") return false;
  return env.VERCEL_ENV === "preview" || env.NODE_ENV === "development";
}

export type LayoutPreviewMode = "modern" | "classic";
export function parseLayoutPreviewMode(raw: string | null): LayoutPreviewMode {
  return raw === "classic" ? "classic" : "modern";
}

export function layoutPreviewStorageKey(actorKey: string) {
  return `motorist:layout-preview:v1:${actorKey}`;
}
