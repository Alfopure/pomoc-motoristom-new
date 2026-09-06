import { TELEPHONY_TIMEOUT_MS, telephonyJson } from "@/lib/telephony/client-request";

export class RecordingRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "RecordingRequestError";
  }
}

/** A timeout does not prove that a mutation failed; callers refresh before retrying. */
export async function recordingRequest<T>(url: string, options: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = options.method ?? "GET";
  const result = await telephonyJson<T & { error?: string; code?: string }>(url, {
    method,
    label: method === "GET" ? "záznam a kvalita hovoru" : "uloženie záznamu hovoru",
    timeoutMs: method === "GET" ? TELEPHONY_TIMEOUT_MS.read : TELEPHONY_TIMEOUT_MS.mutation,
    signal: options.signal,
    ...(options.body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body) }),
  });
  if (!result.ok || !result.body) {
    const fallback = result.status === 401 ? "Prihlásenie vypršalo. Prihláste sa znova."
      : result.status === 403 ? "Na tento záznam nemáte oprávnenie."
        : result.status === 409 ? "Podklady sa zmenili. Načítajte aktuálnu verziu a skontrolujte svoju úpravu."
          : result.status === 410 ? "Záznam bol odstránený alebo jeho platnosť skončila."
            : "Požiadavku sa nepodarilo dokončiť. Skúste načítať aktuálny stav.";
    throw new RecordingRequestError(result.body?.error ?? fallback, result.status, result.body?.code ?? "recording_request_failed");
  }
  return result.body;
}

export function recordingErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Požiadavku sa nepodarilo dokončiť.";
}
