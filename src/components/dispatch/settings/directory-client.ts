import type { DispatchData } from "@/data/dispatch-types";
import type { DirectoryData, DirectoryDraft, DirectoryEntry } from "@/lib/directory";

export class DirectoryRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new DirectoryRequestError(data?.error ?? "Adresár sa nepodarilo načítať. Skúste to znova.", response.status);
  if (!data) throw new DirectoryRequestError("Server nevrátil údaje adresára.", 503);
  return data as T;
}

export async function loadDirectory(signal?: AbortSignal) {
  return jsonResponse<DirectoryData>(await fetch("/api/directory", { cache: "no-store", signal }));
}

export async function saveDirectory(draft: DirectoryDraft, previous?: DirectoryEntry) {
  const result = await jsonResponse<{ entry: DirectoryEntry; dispatchData?: DispatchData; refreshRequired: boolean }>(await fetch(previous ? `/api/directory/${previous.kind}/${previous.id}` : "/api/directory", {
    method: previous ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...draft, ...(previous ? { expectedUpdatedAt: previous.updatedAt } : {}) }),
  }));
  if (!result.entry?.id) throw new DirectoryRequestError("Server nepotvrdil uloženie záznamu.", 503);
  return result;
}
