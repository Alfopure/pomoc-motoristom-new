/** The route that produced a row is separate from the caller's actual choice. */
export type CallbackOrigin = {
  kind: "requested" | "missed" | "manual" | "unknown";
  requestedAt: string | null;
  digit: string | null;
  context: string | null;
  evidence: "dtmf" | "legacy_confirmation" | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function callbackOrigin(source: string, metadata: unknown, sessionMetadata?: unknown): CallbackOrigin {
  const request = record(record(metadata).request);
  const session = record(sessionMetadata);
  const confirmation = record(session.callback);
  if (request.kind === "requested" && string(request.requested_at) && string(request.digit)) {
    return { kind: "requested", requestedAt: string(request.requested_at), digit: string(request.digit), context: string(request.context), evidence: "dtmf" };
  }
  // Old rows used source="missed" even after a confirmed digit. Recover the
  // distinction without rewriting history or inventing an unrecorded digit.
  if (confirmation.confirmed === true && string(confirmation.requested_at)) {
    return {
      kind: "requested", requestedAt: string(confirmation.requested_at),
      digit: string(confirmation.digit) ?? (source === "ivr" ? string(record(session.ivr).chosen) : null),
      context: string(confirmation.context) ?? source, evidence: "legacy_confirmation",
    };
  }
  return { kind: source === "manual" ? "manual" : source === "missed" ? "missed" : "unknown", requestedAt: null, digit: null, context: source, evidence: null };
}

export const CALLBACK_ORIGIN_LABELS: Record<CallbackOrigin["kind"], string> = {
  requested: "Vyžiadané klientom", missed: "Neprijatý hovor · bez žiadosti", manual: "Zadané dispečerom", unknown: "Starší záznam · voľba neoverená",
};

export function callbackOriginDetail(origin: CallbackOrigin): string | null {
  if (origin.kind !== "requested") return null;
  const action = origin.digit ? `Klient stlačil ${origin.digit}` : "Klient potvrdil spätné volanie";
  const time = origin.requestedAt ? new Date(origin.requestedAt) : null;
  return time && Number.isFinite(time.getTime())
    ? `${action} · ${time.toLocaleString("sk-SK", { timeZone: "Europe/Bratislava", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
    : action;
}
