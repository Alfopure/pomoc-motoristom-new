import type { TowingCommand, TowingCommandResult, TowingView, TowingWorkspace } from "@/domain/towing/types";

export class TowingRequestError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); this.name = "TowingRequestError"; }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(url, { ...init, credentials: "same-origin", cache: "no-store", signal: init?.signal ?? AbortSignal.timeout(75_000) }); }
  catch { throw new TowingRequestError("Spojenie sa prerušilo. Uloženie zatiaľ nie je potvrdené. Zopakujte rovnaký pokus po obnovení spojenia.", 0); }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const fallback = response.status === 409 ? "Údaje medzičasom niekto zmenil. Vaše úpravy ostali vo formulári. Načítajte aktuálnu verziu a porovnajte ich." : response.status === 403 ? "Prístup sa nepodarilo overiť. Zmeny neboli potvrdené. Skúste obnoviť prihlásenie." : "Požiadavku sa nepodarilo uložiť. Vaše údaje ostali vo formulári.";
    throw new TowingRequestError(typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : fallback, response.status, body?.code);
  }
  return body as T;
}

function acknowledge(result: TowingCommandResult, commandId: string, targetId: string) {
  if (!result || result.commandId !== commandId || result.targetId !== targetId || !Number.isSafeInteger(result.revision) || result.revision < 0)
    throw new TowingRequestError("Server nepotvrdil identitu uloženého záznamu. Uloženie zatiaľ nie je potvrdené; zopakujte rovnaký pokus.", 0, "unconfirmed_ack");
  return result;
}

/** Single online adapter seam: offline code may wrap these methods, never the legacy dispatch API. */
export const towingClient = {
  workspace(view: TowingView, query: Record<string, string> = {}) {
    const search = new URLSearchParams({ view, ...query });
    return request<TowingWorkspace>(`/api/towing/workspace?${search}`);
  },
  async command(command: TowingCommand) {
    const result = await request<TowingCommandResult>("/api/towing/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
    return acknowledge(result, command.commandId, command.targetId);
  },
  async upload(orderId: string, body: FormData) {
    const result = await request<TowingCommandResult>(`/api/towing/orders/${encodeURIComponent(orderId)}/attachments`, { method: "POST", body });
    return acknowledge(result, String(body.get("commandId")), orderId);
  },
  async document(orderId: string, body: { commandId: string; documentId: string; expectedRevision: number; kind: "work" | "priced"; retry?: boolean }) {
    const result = await request<TowingCommandResult>(`/api/towing/orders/${encodeURIComponent(orderId)}/documents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return acknowledge(result, body.commandId, orderId);
  },
  email(orderId: string, body: { commandId: string; documentId: string; recipient: string; confirmed: true }) {
    return request<{ status?: string; result?: Record<string, unknown> }>(`/api/towing/orders/${encodeURIComponent(orderId)}/email`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  },
  members(body: Record<string, unknown>) {
    return request<Record<string, unknown>>("/api/towing/memberships", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  },
  sources(query: { query?: string; sourceId?: string }) {
    return request<{ sources: { id: string; number: string; fields: import("@/domain/towing/types").TowingFields }[] }>(`/api/towing/sources?${new URLSearchParams(query)}`);
  },
  reports(query: Record<string, string>) {
    return request<import("@/domain/towing/types").TowingReport>(`/api/towing/reports?${new URLSearchParams(query)}`);
  },
};

export function fileUrl(orderId: string, attachmentId: string) {
  return `/api/towing/orders/${encodeURIComponent(orderId)}/attachments?attachmentId=${encodeURIComponent(attachmentId)}`;
}
export function documentUrl(orderId: string, documentId: string) {
  return `/api/towing/orders/${encodeURIComponent(orderId)}/documents?documentId=${encodeURIComponent(documentId)}`;
}

export function deliveryStatus(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return;
  const value = body as { status?: unknown; delivery?: { status?: unknown }; result?: { status?: unknown; delivery?: { status?: unknown } } };
  const status = value.status ?? value.delivery?.status ?? value.result?.status ?? value.result?.delivery?.status;
  return typeof status === "string" ? status : undefined;
}
