/** Archived lines retain their identity for historical calls, but cannot be operated. */
export function isArchivedLine(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const archivedAt = (metadata as Record<string, unknown>).archived_at;
  return typeof archivedAt === "string" && archivedAt.trim().length > 0;
}
