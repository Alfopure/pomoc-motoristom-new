/**
 * Case attachment limits shared by the upload route, the new-case form and
 * the case editor. One list, so a type the browser lets through is never one
 * the server refuses (or the other way round).
 */
export const MAX_CASE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const ALLOWED_CASE_ATTACHMENT_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

/** `accept` attribute of the file inputs, derived from the same list. */
export const CASE_ATTACHMENT_ACCEPT = [...ALLOWED_CASE_ATTACHMENT_TYPES].join(",");

/** First problem with the chosen files in the operator's words, or `null` when every file may be uploaded. */
export function validateCaseAttachmentFiles(files: readonly Pick<File, "name" | "size" | "type">[]): string | null {
  for (const file of files) {
    if (file.size <= 0) {
      return `Súbor ${file.name} je prázdny.`;
    }

    if (file.size > MAX_CASE_ATTACHMENT_BYTES) {
      return `Súbor ${file.name} presahuje limit 10 MB.`;
    }

    if (!ALLOWED_CASE_ATTACHMENT_TYPES.has(file.type)) {
      return `Typ súboru ${file.type || "neznámy"} nie je povolený.`;
    }
  }

  return null;
}
