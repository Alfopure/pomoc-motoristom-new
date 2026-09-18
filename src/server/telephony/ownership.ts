import { measureRequestStep } from "@/server/request-metrics";
import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { SessionLeaseLostError } from "./service-errors";

export const SESSION_WORK_MS = 24_000;
export const SESSION_LEASE_MS = 15_000;
/**
 * A lease taken this recently cannot have expired (TTL is `SESSION_LEASE_MS`),
 * so a nested scope re-entering the same session may skip its renew RPC. The
 * renew never was what protects the write: every owned request carries the
 * token/generation headers and the database fence rejects a stale writer.
 */
export const OWNERSHIP_RENEW_SKIP_MS = 5_000;
export const DATABASE_REQUEST_MS = 4_000;
export type Ownership = {
  admin: SupabaseClient<Database>;
  sessionId: string;
  organizationId: string;
  token: string;
  generation: number;
  contract: number;
  deadline: number;
  /** `Date.now()` of the acquisition, for `OWNERSHIP_RENEW_SKIP_MS`. */
  acquiredAt: number;
  /** `Date.now()` of the last renew, so a burst of commands renews once rather than each. */
  renewedAt?: number;
  terminationPending?: boolean;
  /** Includes acquisition by an outer webhook owner, before the reducer starts. */
  leaseWaitMs?: number;
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
    // Keep the SQLSTATE on the error: callers distinguish a fenced refusal
    // (PT409) from an ordinary failure without re-parsing the message.
    const failure = new Error(`${name}: ${error.message}`);
    if (error.code) (failure as Error & { code?: string }).code = error.code;
    throw failure;
  }
  return data as T;
}

export async function assertOwnership(owner = sessionOwnership.getStore()): Promise<void> {
  if (!owner) return;
  if (Date.now() >= owner.deadline) throw new SessionLeaseLostError();
  // A lease renewed this recently cannot expire before the next check: the TTL
  // is `SESSION_LEASE_MS` and the window is a third of it.
  //
  // Skipping the renew is not skipping a guard. Every owned request carries
  // the token and the generation, and `motorist_telephony_fence` refuses a
  // stale writer on the write itself — a lease taken by somebody else is
  // noticed at that write instead of a moment earlier. The double models the
  // fence now, so that is a tested claim rather than an argument.
  //
  // The saving is per command: a burst — three journalled commands behind one
  // answer, or a fan-out of N dials — renewed once each.
  const since = Date.now() - (owner.renewedAt ?? owner.acquiredAt);
  if (since >= 0 && since < OWNERSHIP_RENEW_SKIP_MS) return;
  const ok = await ownershipRpc<boolean>(owner.admin, "motorist_session_lease_renew_v2", {
    p_session_id: owner.sessionId, p_token: owner.token, p_generation: owner.generation, p_ttl_ms: SESSION_LEASE_MS,
  });
  if (!ok) throw new SessionLeaseLostError();
  owner.renewedAt = Date.now();
}
