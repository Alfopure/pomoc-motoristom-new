export type GlassPreferences = { reduceTransparency: boolean; reduceMotion: boolean };
export type GlassCapabilities = { isLiquidGlassAvailable?: boolean; isGlassEffectAPIAvailable?: boolean };
export type SurfaceKind = "glass" | "blur" | "solid";

export function surfaceKind(platform: string, preferences: GlassPreferences, glass: GlassCapabilities | null, blurAvailable: boolean): SurfaceKind {
  if (platform !== "ios" || preferences.reduceTransparency) return "solid";
  if (glass?.isLiquidGlassAvailable === true && glass.isGlassEffectAPIAvailable === true) return "glass";
  return blurAvailable ? "blur" : "solid";
}

/** Decorative native packages eagerly register views on import. Never import a
 * package missing from an older binary; their absence is a supported surface. */
export async function loadSurface<T>(kind: SurfaceKind, loaders: { glass: () => Promise<T>; blur: () => Promise<T> }): Promise<T | null> {
  if (kind === "solid") return null;
  try { return await loaders[kind](); }
  catch { return null; }
}
