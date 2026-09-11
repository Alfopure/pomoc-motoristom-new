import { measureRequestStep } from "@/server/request-metrics";
import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { SessionLeaseLostError } from "./service-errors";

export const SESSION_WORK_MS = 24_000;
export const SESSION_LEASE_MS = 15_000;
export const DATABASE_REQUEST_MS = 4_000;
export type Ownership = {
  admin: SupabaseClient<Database>;
  sessionId: string;
  organizationId: string;
  token: string;
  generation: number;
  contract: number;
  deadline: number;
  terminationPending?: boolean;
};
export const sessionOwnership = new AsyncLocalStorage<Ownership>();

/** The headers belong to this async invocation, never to a shared client. */
export async function telephonyDatabaseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("x-telephony-writer", "2");
  const owner = sessionOwnership.getStore();
  if (owner) {
    headers.set("x-telephony-session", owner.sessionId);
    headers.set("x-telephony-token", owner.token);
    headers.set("x-telephony-generation", String(owner.generation));
  }
  if (!owner) return measureRequestStep("db", () => fetch(input, { ...init, headers }));
  const remaining = owner.deadline - Date.now();
  if (remaining <= 0) throw new SessionLeaseLostError();
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(DATABASE_REQUEST_MS, remaining)));
  return measureRequestStep("db", () => fetch(input, { ...init, headers, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout }));
}

export async function ownershipRpc<T>(admin: SupabaseClient<Database>, name: string, args: Record<string, unknown>): Promise<T> {
  type RpcRequest = PromiseLike<{ data: Json; error: { message: string; code?: string } | null }> & { abortSignal?: (signal: AbortSignal) => unknown };
  const call = admin.rpc.bind(admin) as unknown as (name: string, args: Record<string, unknown>) => RpcRequest;
  const request = call(name, args);
  // Acquisition and release occur outside the owned scope too. Bound these
  // telephony RPCs without changing unrelated application's write timeouts.
  const remaining = (sessionOwnership.getStore()?.deadline ?? Date.now() + DATABASE_REQUEST_MS) - Date.now();
  if (remaining <= 0) throw new SessionLeaseLostError();
  request.abortSignal?.(AbortSignal.timeout(Math.max(1, Math.min(DATABASE_REQUEST_MS, remaining))));
  const { data, error } = await request;
  if (error) {
    if (error.code === "PT409" && /ownership|writer|lease|contract/.test(error.message)) throw new SessionLeaseLostError();
    throw new Error(`${name}: ${error.message}`);
  }
  return data as T;
}

export async function assertOwnership(owner = sessionOwnership.getStore()): Promise<void> {
  if (!owner) return;
  if (Date.now() >= owner.deadline) throw new SessionLeaseLostError();
  const ok = await ownershipRpc<boolean>(owner.admin, "motorist_session_lease_renew_v2", {
    p_session_id: owner.sessionId, p_token: owner.token, p_generation: owner.generation, p_ttl_ms: SESSION_LEASE_MS,
  });
  if (!ok) throw new SessionLeaseLostError();
}
