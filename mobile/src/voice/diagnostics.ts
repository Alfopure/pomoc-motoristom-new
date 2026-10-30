/** Fields of one device-log line: reason codes, flags, counts and short IDs only. */
export type DiagnosticFields = Record<string, string | number | boolean | null | undefined>;
/** One event of the native device-log ring, with the same sanitized values as its log line. */
export type VoiceDiagnosticEvent = { id: number; at: number; event: string; fields: Record<string, string> };

// A phone number: seven or more digits, each pair split by at most one separator.
const phoneLike = /\d(?:[._:-]?\d){6,}/;
function clean(text: string, limit: number) {
  const kept = text.toLowerCase().replace(/[^a-z0-9_.:-]/g, "");
  return phoneLike.test(kept) ? "redacted" : kept.slice(0, limit);
}

/** The iPhone device log is public: keep only [a-z0-9_.:-], cap lengths and redact any
 * phone-number-like digit run. Null when nothing is left of the event name. */
export function sanitizeDiagnostic(event: string, fields: DiagnosticFields = {}): { event: string; fields: Record<string, string> } | null {
  const name = clean(String(event), 48);
  if (!name) return null;
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields ?? {}).slice(0, 16)) {
    const field = clean(key, 32);
    const text = typeof value === "string" ? value : typeof value === "boolean" || Number.isSafeInteger(value) ? String(value) : null;
    if (field && text !== null) safe[field] = clean(text, 40) || "none";
  }
  return { event: name, fields: safe };
}
