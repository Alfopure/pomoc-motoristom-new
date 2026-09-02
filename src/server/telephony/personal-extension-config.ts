import "server-only";

const DEFAULT_PERSONAL_EXTENSIONS = ["20", "21", "22", "23"] as const;
const LEGACY_SEEDED_PROFILE_EXTENSIONS = ["101", "102", "103", "104", "105"] as const;

/**
 * Returns the only extensions that may be used as personal dispatch seats.
 * An explicitly configured but malformed allowlist fails closed instead of
 * silently falling back to the defaults.
 */
export function configuredPersonalExtensions(): string[] {
  const raw = process.env.VIPTEL_DISPATCH_PERSONAL_EXTENSIONS;
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_PERSONAL_EXTENSIONS];

  const values = raw.split(",").map((value) => value.trim());
  if (values.length === 0 || values.some((value) => !/^\d{1,8}$/.test(value))) {
    throw new Error("VIPTEL_DISPATCH_PERSONAL_EXTENSIONS contains an invalid personal extension allowlist.");
  }

  return [...new Set(values)];
}

export function isConfiguredPersonalExtension(extension: string) {
  return configuredPersonalExtensions().includes(extension);
}

/**
 * Compatibility boundary for the original demo operator seats. These values
 * may be replaced only by the explicit, guarded personal-extension assignment
 * flow; arbitrary non-personal profile values stay fail-closed.
 */
export function isLegacySeededProfileExtension(extension: string) {
  return (
    LEGACY_SEEDED_PROFILE_EXTENSIONS.some((candidate) => candidate === extension) &&
    !isConfiguredPersonalExtension(extension)
  );
}
