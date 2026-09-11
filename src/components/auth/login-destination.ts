/** Only server-selected guide paths can replace the normal sign-in destination. */
export function loginDestination(currentUrl: string, guidePath?: string): string {
  const current = new URL(currentUrl);
  if (guidePath && /^\/navod(?:\/[a-z0-9-]+)?$/.test(guidePath)) {
    return `${guidePath}${current.hash}`;
  }
  const taskId = current.searchParams.get("task");
  return taskId ? `/?task=${encodeURIComponent(taskId)}` : "/";
}
