import "server-only";
import type { DirectoryEntry } from "@/lib/directory";
import { loadDispatchData } from "@/data/dispatch-repository";
import { MutationError } from "./mutation-error";

export async function readDirectoryBody(request: Request): Promise<unknown> {
  const body = await request.text();
  if (body.length > 32_000) throw new MutationError("Záznam je príliš veľký.", 413);
  try { return JSON.parse(body); } catch { throw new MutationError("Záznam nemá platný formát.", 400); }
}

export function directoryErrorResponse(error: unknown) {
  if (error instanceof MutationError) return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "private, no-store" } });
  console.error("Directory request failed", error);
  return Response.json({ error: "Adresár sa nepodarilo spracovať. Skúste to znova." }, { status: 503 });
}

export async function directorySavedResponse(entry: DirectoryEntry) {
  // The write has committed. A failed console refresh is distinct from a failed save.
  const refreshed = await loadDispatchData().catch(error => { console.error("Directory saved, console refresh failed", error); return undefined; });
  const dispatchData = refreshed?.source === "supabase" ? refreshed : undefined;
  return Response.json({ entry, dispatchData, refreshRequired: !dispatchData }, { headers: { "Cache-Control": "private, no-store" } });
}
