import "server-only";

/** A stable identifier shared by the rendered app and uncached release checks. */
export function getAppVersion(env: Record<string, string | undefined> = process.env): string {
  return (
    env.VERCEL_DEPLOYMENT_ID?.trim() ||
    env.DEPLOYMENT_VERSION?.trim() ||
    env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    "development"
  );
}
