/** Diagnostic text is deliberately smaller than the provider payload and safe to forward for support. */
export function redactAlertText(value: string): string {
  // Bound input before regular expressions as well as output: provider errors
  // can contain a very large body, and sanitizing it must not stall the cron.
  return value.slice(0, 800)
    .replace(/(?:https?|postgres(?:ql)?):\/\/[^\s<>"']+/gi, "[URL vynechaná]")
    .replace(/sips?:[^\s<>"']+/gi, "[SIP vynechané]")
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, "$1 [vynechané]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[token vynechaný]")
    .replace(/(["']?[\w-]*(?:api[_-]?key|secret|password|token|authorization|credential|service[_-]?role[_-]?key)[\w-]*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, "$1[vynechané]")
    .replace(/\b((?:api[_ -]?key|secret|password|token|authorization|credential)[\w-]*\s*[:=]\s*)[^\s,;]+/gi, "$1[vynechané]")
    .replace(/\+[1-9]\d{7,14}\b/g, "[telefón vynechaný]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[e-mail vynechaný]")
    .slice(0, 800);
}

function failureSummary(value: unknown): unknown {
  if (value === null || value === undefined || value === "" || Array.isArray(value) && value.length === 0) return value ?? null;
  const text = typeof value === "string" ? value.slice(0, 800) : "";
  const category = /timeout|timed out|abort/i.test(text) ? "timeout"
    : /429|rate.?limit/i.test(text) ? "rate_limited"
      : /401|403|unauthori[sz]ed|forbidden|access denied/i.test(text) ? "access_denied"
        : /sessions_lookup|legs_lookup|ledger_|database|postgres|supabase/i.test(text) ? "database_read_failed" : "unclassified_error";
  return { present: true, category };
}

export function redactAlertDiagnostic(value: unknown, depth = 0): unknown {
  if (depth > 7) return "[skrátené]";
  if (typeof value === "string") return redactAlertText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((entry) => redactAlertDiagnostic(entry, depth + 1));
  if (!value || typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, entry]) => [redactAlertText(key),
    /error|message|stack|trace/i.test(key) ? failureSummary(entry) :
    /password|secret|token|credential|authorization|cookie|api.?key|service.?role.?key|sip.?user|payload|client.?state|metadata|headers|recording.?url|body/i.test(key)
      ? "[vynechané]" : redactAlertDiagnostic(entry, depth + 1),
  ]));
}
