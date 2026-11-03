/** Fields of one device-log line: reason codes, flags, counts and short IDs only. */
export type DiagnosticFields = Record<string, string | number | boolean | null | undefined>;
/** One event of the native device-log ring, with the same sanitized values as its log line. */
export type VoiceDiagnosticEvent = { id: number; at: number; event: string; fields: Record<string, string> };

// A phone number: seven or more digits in total once everything else is removed.
const phoneLike = (text: string) => text.replace(/\D/g, "").length >= 7;
function clean(text: string, limit: number) {
  const kept = text.toLowerCase().replace(/[^a-z0-9_.:-]/g, "");
  return phoneLike(kept) ? "redacted" : kept.slice(0, limit);
}
/** A key that carries an ID; as on the server, it holds only an app ID's 8 lowercase hex characters or a flag. */
export function diagnosticIdKey(key: string) {
  return ["call", "session", "action", "leg", "control", "user", "profile", "client", "device", "token", "push_token"].includes(key) || key.endsWith("_id");
}
const ID_VALUE = /^(?:[a-f0-9]{8}|true|false|none)$/;

/** The iPhone device log is public: keep only [a-z0-9_.:-], cap lengths and redact any value
 * with seven or more digits. An ID key keeps only an 8-hex ID or a flag; anything else is dropped.
 * Null when nothing is left of the event name. */
export function sanitizeDiagnostic(event: string, fields: DiagnosticFields = {}): { event: string; fields: Record<string, string> } | null {
  const name = clean(String(event), 48);
  if (!name) return null;
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields ?? {}).slice(0, 16)) {
    const field = clean(key, 32);
    const text = typeof value === "string" ? value : typeof value === "boolean" || Number.isSafeInteger(value) ? String(value) : null;
    if (!field || text === null) continue;
    if (!diagnosticIdKey(field)) safe[field] = clean(text, 40) || "none";
    else if (ID_VALUE.test(text.trim().toLowerCase())) safe[field] = text.trim().toLowerCase();
  }
  return { event: name, fields: safe };
}
