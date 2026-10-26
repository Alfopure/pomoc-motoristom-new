/** Only explicitly allowlisted local destinations may replace the default. */
export function loginDestination(currentUrl: string, guidePath?: string): string {
  const current = new URL(currentUrl);
  if (guidePath === "/vodic" || guidePath === "/zakazky" || guidePath === "/partner" || guidePath === "/moje-jazdy") return guidePath;
  if (guidePath && /^\/navod(?:\/[a-z0-9-]+)?$/.test(guidePath)) {
    return `${guidePath}${current.hash}`;
  }
  const caseId = current.searchParams.get("case");
  if (caseId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(caseId)) return `/?case=${encodeURIComponent(caseId)}`;
  const taskId = current.searchParams.get("task");
  return taskId ? `/?task=${encodeURIComponent(taskId)}` : "/";
}
