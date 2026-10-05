import type { AppEnvironment } from "./app-environment";

export type AppRelease = {
  environment: AppEnvironment;
  /** Content-derived identifier shared across builds of the same application inputs. */
  code: string | null;
  builtAt: string | null;
  commit: string | null;
  /** Deployment identity remains separate, so a rebuild still triggers the update notice. */
  deployment: string;
};

export const localAppRelease: AppRelease = {
  environment: "development", code: null, builtAt: null, commit: null, deployment: "development",
};

export const appEnvironmentLabels: Record<AppEnvironment, string> = {
  production: "PRODUKCIA", test: "TEST", development: "VÝVOJ",
};

export function appReleaseDate(builtAt: string | null): string | null {
  if (!builtAt || !Number.isFinite(Date.parse(builtAt))) return null;
  return new Intl.DateTimeFormat("sk-SK", {
    day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Bratislava",
  }).format(new Date(builtAt)).replace(/\s/g, "");
}
